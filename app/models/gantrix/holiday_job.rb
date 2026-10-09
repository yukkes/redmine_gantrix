# frozen_string_literal: true

# Background refresh of the Cabinet Office holiday CSV.
class Gantrix::HolidayJob < ActiveJob::Base
  # SQLite's "database is locked" arrives as a plain StatementInvalid
  class Busy < StandardError; end

  # SQLite allows one writer at a time; try again shortly instead of waiting for the next day
  retry_on ActiveRecord::StatementTimeout, ActiveRecord::LockWaitTimeout, Busy, wait: 15.seconds, attempts: 4

  def perform
    Gantrix::HolidaySource.fetch_cao!
  rescue Gantrix::HolidaySource::Error => e
    Rails.logger.warn("[gantrix] holiday CSV fetch failed: #{e.message}")
  rescue ActiveRecord::StatementInvalid => e
    raise unless e.cause.class.name == 'SQLite3::BusyException'

    raise Busy, e.message
  end
end
