# frozen_string_literal: true

# Loaded by Redmine's config/application.rb (copied in by docker/deploy/Dockerfile).

# Compress text responses with gzip, including the static files served from public/.
config.middleware.insert_before ActionDispatch::Static, Rack::Deflater,
                                include: %w[text/html text/css text/javascript application/javascript application/json image/svg+xml text/plain text/csv]

# Files under /assets/ have a digest in their name, so browsers may keep them for a year.
asset_cache_headers = Class.new do
  def initialize(app)
    @app = app
  end

  def call(env)
    status, headers, body = @app.call(env)
    headers['cache-control'] = 'public, max-age=31536000, immutable' if status == 200 && env['PATH_INFO'].start_with?('/assets/')
    [status, headers, body]
  end
end
config.middleware.insert_before ActionDispatch::Static, asset_cache_headers
