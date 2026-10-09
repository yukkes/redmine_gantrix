# frozen_string_literal: true

# Loaded first by the scripts run with `rails runner` (demo data, checks).
# The Docker images configure SQLite without a busy timeout, and the server and these scripts write at the
# same time right after start (the holiday refresh job): "database is locked".
# - jobs run inline, so this process never has a second writer in a background thread
# - every connection waits up to 10 s for the other process
ActiveJob::Base.queue_adapter = :inline
config = ActiveRecord::Base.connection_db_config.configuration_hash
ActiveRecord::Base.establish_connection(config.merge(timeout: 10_000)) if config[:adapter].to_s.include?('sqlite') && config[:timeout].blank?
