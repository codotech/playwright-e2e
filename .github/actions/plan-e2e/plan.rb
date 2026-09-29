require "digest"
require "json"
require "open3"
require "pathname"
require "securerandom"
require "uri"
require "yaml"

workspace_argument, profile_name, projects_override,
  labels_override, label_match_override, output_file = ARGV

def fail_plan(message)
  raise ArgumentError, message
end

def require_mapping(value, label)
  fail_plan("#{label} must be a mapping") unless value.is_a?(Hash)
  value
end

def reject_unknown_keys(mapping, allowed, label)
  unknown = mapping.keys.map(&:to_s) - allowed
  return if unknown.empty?

  fail_plan("#{label} contains unknown keys: #{unknown.sort.join(', ')}")
end

def require_relative_path(value, label)
  fail_plan("#{label} must be a non-empty string") unless value.is_a?(String) && !value.empty?

  path = Pathname.new(value)
  fail_plan("#{label} must be repository-relative") if path.absolute?

  clean = path.cleanpath.to_s
  fail_plan("#{label} must remain below its parent directory") if clean == "." || clean == ".." || clean.start_with?("../")
  clean
end

def require_string_list(value, label, allow_empty: true)
  fail_plan("#{label} must be a list") unless value.is_a?(Array)
  fail_plan("#{label} must not be empty") if !allow_empty && value.empty?

  normalized = value.map do |entry|
    fail_plan("#{label} entries must be non-empty strings") unless entry.is_a?(String) && !entry.strip.empty?
    fail_plan("#{label} entries must not contain newlines") if entry.match?(/[\r\n]/)
    fail_plan("#{label} entries must not contain null bytes") if entry.include?("\0")
    entry.strip
  end
  fail_plan("#{label} entries must be unique") unless normalized.uniq.length == normalized.length
  normalized
end

def parse_override(value)
  value.to_s.lines.map(&:strip).reject(&:empty?).uniq
end

def normalize_profile(name, value)
  profile = require_mapping(value, "profiles.#{name}")
  reject_unknown_keys(profile, %w[projects labels labelMatch], "profiles.#{name}")
  projects = require_string_list(profile["projects"], "profiles.#{name}.projects", allow_empty: false)
  labels = require_string_list(profile["labels"], "profiles.#{name}.labels")
  labels.each do |label|
    fail_plan("labels must begin with @ and contain a name: #{label}") unless label.start_with?("@") && label.length > 1
  end
  label_match = profile["labelMatch"]
  fail_plan("profiles.#{name}.labelMatch must be all or any") unless %w[all any].include?(label_match)
  { "projects" => projects, "labels" => labels, "labelMatch" => label_match }
end

def append_output(file, name, value)
  string = value.to_s
  if string.include?("\n")
    begin
      delimiter = "E2E_#{SecureRandom.hex(16)}"
    end while string.lines.map(&:chomp).include?(delimiter)
    File.open(file, "a") do |output|
      output.puts("#{name}<<#{delimiter}")
      output.puts(string)
      output.puts(delimiter)
    end
  else
    File.open(file, "a") { |output| output.puts("#{name}=#{string}") }
  end
end

workspace = Pathname.new(workspace_argument).realpath
config_relative = "e2e/ci.yml"
config_path = workspace.join(config_relative)
fail_plan("e2e/ci.yml does not exist") unless config_path.file?
fail_plan("e2e/ci.yml must not be a symbolic link") if config_path.symlink?
fail_plan("e2e/ci.yml is too large") if config_path.size > 65_536

resolved_config = config_path.realpath
relative_config = resolved_config.relative_path_from(workspace).to_s
fail_plan("e2e/ci.yml must remain inside GITHUB_WORKSPACE") if relative_config == ".." || relative_config.start_with?("../")

manifest = YAML.safe_load(
  resolved_config.read,
  permitted_classes: [],
  permitted_symbols: [],
  aliases: false,
)
manifest = require_mapping(manifest, "manifest")
reject_unknown_keys(manifest, %w[version runner playwright sut execution profiles], "manifest")
fail_plan("manifest version must be 1") unless manifest["version"] == 1

runner = require_mapping(manifest["runner"], "runner")
reject_unknown_keys(runner, %w[dockerfile], "runner")
dockerfile = require_relative_path(runner["dockerfile"], "runner.dockerfile")

playwright = require_mapping(manifest["playwright"], "playwright")
reject_unknown_keys(playwright, %w[config], "playwright")
playwright_config = require_relative_path(playwright["config"], "playwright.config")

sut = require_mapping(manifest["sut"], "sut")
reject_unknown_keys(sut, %w[composeFile baseUrl], "sut")
compose_file = sut.key?("composeFile") ? require_relative_path(sut["composeFile"], "sut.composeFile") : ""
begin
  base_url = URI(sut["baseUrl"].to_s)
rescue URI::InvalidURIError
  fail_plan("sut.baseUrl must be an HTTP or HTTPS URL")
end
fail_plan("sut.baseUrl must be an HTTP or HTTPS URL") unless %w[http https].include?(base_url.scheme) && base_url.host
fail_plan("sut.baseUrl must not contain credentials or a fragment") if base_url.userinfo || base_url.fragment

execution = require_mapping(manifest["execution"], "execution")
reject_unknown_keys(execution, %w[shards artifactRetentionDays], "execution")
shard_count = execution["shards"]
fail_plan("execution.shards must be an integer from 1 through 32") unless shard_count.is_a?(Integer) && shard_count.between?(1, 32)
retention_days = execution["artifactRetentionDays"]
fail_plan("execution.artifactRetentionDays must be an integer from 1 through 90") unless retention_days.is_a?(Integer) && retention_days.between?(1, 90)

profiles = require_mapping(manifest["profiles"], "profiles")
fail_plan("profiles must contain at least one profile") if profiles.empty?
normalized_profiles = profiles.each_with_object({}) do |(name, value), result|
  fail_plan("profile names must be non-empty strings") unless name.is_a?(String) && !name.empty?
  result[name] = normalize_profile(name, value)
end
fail_plan("profile must be a non-empty string") unless profile_name.is_a?(String) && !profile_name.empty?
unless normalized_profiles.key?(profile_name)
  fail_plan("unknown profile #{profile_name}; available profiles: #{normalized_profiles.keys.sort.join(', ')}")
end
profile = normalized_profiles.fetch(profile_name)
projects = profile.fetch("projects")
labels = profile.fetch("labels")
label_match = profile.fetch("labelMatch")

override_projects = parse_override(projects_override)
override_labels = parse_override(labels_override)
projects = override_projects unless override_projects.empty?
labels = override_labels unless override_labels.empty?
unless label_match_override.to_s.empty?
  fail_plan("label-match override must be all or any") unless %w[all any].include?(label_match_override)
  label_match = label_match_override
end
labels.each do |label|
  fail_plan("labels must begin with @ and contain a name: #{label}") unless label.start_with?("@") && label.length > 1
end

working_directory_path = resolved_config.dirname.realpath
working_directory = working_directory_path.relative_path_from(workspace).to_s
fail_plan("e2e/ci.yml must live below the repository root") if working_directory == "." || working_directory.start_with?("../")

dockerfile_path = working_directory_path.join(dockerfile).cleanpath
playwright_config_path = working_directory_path.join(playwright_config).cleanpath
required_paths = [
  [dockerfile_path, "runner.dockerfile"],
  [playwright_config_path, "playwright.config"],
]
compose_path = workspace.join(compose_file).cleanpath unless compose_file.empty?
required_paths << [compose_path, "sut.composeFile"] if compose_path
required_paths.each do |path, label|
  fail_plan("#{label} does not exist: #{path}") unless path.file?
end
fail_plan("runner.dockerfile must remain inside the E2E directory") unless dockerfile_path.realpath.to_s.start_with?("#{working_directory_path}/")
fail_plan("playwright.config must remain inside the E2E directory") unless playwright_config_path.realpath.to_s.start_with?("#{working_directory_path}/")
if compose_path && !compose_path.realpath.to_s.start_with?("#{workspace}/")
  fail_plan("sut.composeFile must remain inside the repository")
end

files_output, files_error, files_status = Open3.capture3(
  "git",
  "-C",
  workspace.to_s,
  "ls-files",
  "-z",
  "--cached",
  "--others",
  "--exclude-standard",
  "--",
  working_directory,
)
fail_plan("cannot enumerate E2E sources: #{files_error.strip}") unless files_status.success?
files = files_output.split("\0").reject(&:empty?).sort
files.reject! { |relative_file| relative_file == relative_config }
fail_plan("E2E directory contains no source files") if files.empty?

digest = Digest::SHA256.new
digest.update("e2e-runner-content-v1\0")
digest.update("runner.dockerfile\0")
digest.update(dockerfile)
digest.update("\0")
files.each do |relative_file|
  path = workspace.join(relative_file)
  digest.update(relative_file)
  digest.update("\0")
  digest.update(path.lstat.mode.to_s(8))
  digest.update("\0")
  if path.symlink?
    digest.update("symlink\0")
    digest.update(path.readlink.to_s)
  elsif path.file?
    digest.update("file\0")
    digest.update(path.binread)
  else
    fail_plan("unsupported E2E source type: #{relative_file}")
  end
  digest.update("\0")
end

append_output(output_file, "working-directory", working_directory)
append_output(output_file, "dockerfile", dockerfile)
append_output(output_file, "playwright-config", playwright_config)
append_output(output_file, "compose-file", compose_file)
append_output(output_file, "base-url", base_url.to_s)
append_output(output_file, "projects", projects.join("\n"))
append_output(output_file, "labels", labels.join("\n"))
append_output(output_file, "label-match", label_match)
append_output(output_file, "shard-count", shard_count)
append_output(output_file, "matrix", { shard: (1..shard_count).to_a }.to_json)
append_output(output_file, "artifact-retention-days", retention_days)
append_output(output_file, "runner-content-hash", digest.hexdigest)
append_output(output_file, "profile", profile_name)
