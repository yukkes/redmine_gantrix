# frozen_string_literal: true

require 'csv'
require 'net/http'

# Holiday data kept in the plugin settings (no extra table):
#
#   holiday_source        'jp' | 'imported' | 'none'
#   jp_cache              Cabinet Office CSV, normalized to "YYYY-MM-DD,name" lines
#   jp_cache_fetched_at   / jp_cache_attempted_at / jp_cache_error
#   imported_holidays     imported CSV, normalized the same way
#   imported_name         / imported_at
#   extra_holidays        company holidays (one date per line)
class Gantrix::HolidaySource
  class Error < StandardError; end

  CAO_URL = 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv'
  REFRESH_AFTER = 30 * 24 * 3600
  RETRY_AFTER = 24 * 3600
  MIN_YEAR = 2000
  MAX_ROWS = 5000

  class << self
    def settings
      Gantrix::Settings.read
    end

    # Merge into the plugin settings instead of replacing them.
    def update(changes)
      Gantrix::Settings.update(changes)
    end

    def source(s = settings)
      return s['holiday_source'] if %w[jp imported none].include?(s['holiday_source'])

      s['jp_holidays'].to_s == '0' ? 'none' : 'jp'
    end

    def parse_list(text)
      text.to_s.each_line.with_object({}) do |line, h|
        date, name = line.strip.split(',', 2)
        next if date.blank?

        h[Date.iso8601(date)] = name.to_s
      rescue ArgumentError
        next
      end
    end

    def dump_list(hash)
      hash.sort.map { |d, n| "#{d.iso8601},#{n.to_s.tr("\r\n,", '   ').strip}" }.join("\n")
    end

    # "date,name" CSV (header optional, UTF-8 or Shift_JIS, YYYY-MM-DD or YYYY/M/D).
    def parse_csv(bytes)
      text = bytes.to_s.dup.force_encoding(Encoding::UTF_8)
      text = bytes.to_s.dup.force_encoding(Encoding::Windows_31J).encode(Encoding::UTF_8) unless text.valid_encoding?
      text = text.delete_prefix('﻿')
      rows = CSV.parse(text)
      raise Error, ::I18n.t(:error_gantrix_csv_too_large, max: MAX_ROWS) if rows.size > MAX_ROWS

      result = rows.each_with_object({}) do |row, h|
        date = parse_date(row[0])
        h[date] = row[1].to_s.strip if date
      end
      raise Error, ::I18n.t(:error_gantrix_csv_empty) if result.empty?

      result
    rescue CSV::MalformedCSVError, EncodingError => e
      raise Error, ::I18n.t(:error_gantrix_csv_invalid, message: e.message)
    end

    def parse_date(value)
      v = value.to_s.strip
      return unless v =~ %r{\A(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\z}

      Date.new(::Regexp.last_match(1).to_i, ::Regexp.last_match(2).to_i, ::Regexp.last_match(3).to_i)
    rescue ArgumentError
      nil
    end

    # Download the Cabinet Office CSV and cache it. Returns the number of days.
    def fetch_cao!
      now = Time.now.utc.iso8601
      body = http_get(settings['jp_csv_url'].presence || CAO_URL)
      days = parse_csv(body).select { |d, _| d.year >= MIN_YEAR }
      update('jp_cache' => dump_list(days), 'jp_cache_fetched_at' => now,
             'jp_cache_attempted_at' => now, 'jp_cache_error' => nil)
      days.size
    rescue StandardError => e
      update('jp_cache_attempted_at' => now, 'jp_cache_error' => e.message.to_s[0, 300])
      raise Error, e.message
    end

    def stale?(s = settings)
      return false unless source(s) == 'jp'

      attempted = time(s['jp_cache_attempted_at'])
      return false if attempted && attempted > Time.now - RETRY_AFTER

      fetched = time(s['jp_cache_fetched_at'])
      fetched.nil? || fetched < Time.now - REFRESH_AFTER
    end

    # Called on every calendar build; fetches in the background at most once a day.
    def refresh_later_if_stale
      s = settings
      return unless stale?(s)

      update('jp_cache_attempted_at' => Time.now.utc.iso8601)
      Gantrix::HolidayJob.perform_later
    rescue StandardError => e
      Rails.logger.warn("[gantrix] holiday refresh not scheduled: #{e.message}")
    end

    def time(value)
      value.present? ? Time.iso8601(value.to_s) : nil
    rescue ArgumentError
      nil
    end

    private

    def http_get(url, limit = 3)
      uri = URI.parse(url)
      raise Error, "unsupported URL: #{url}" unless uri.is_a?(URI::HTTP)

      res = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == 'https', open_timeout: 5, read_timeout: 15) do |http|
        http.get(uri.request_uri)
      end
      case res
      when Net::HTTPSuccess then res.body
      when Net::HTTPRedirection
        raise Error, 'too many redirects' if limit.zero?

        http_get(URI.join(url, res['location']).to_s, limit - 1)
      else
        raise Error, "HTTP #{res.code}"
      end
    end
  end
end
