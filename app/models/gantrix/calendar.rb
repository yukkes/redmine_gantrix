# frozen_string_literal: true

require 'date'

# Working-day calendar: Redmine's non-working week days + Japanese public
# holidays (optional) + company holidays from the plugin settings.
class Gantrix::Calendar
  COMPANY_HOLIDAY = '会社休日'
  HOLIDAY_NAMES_EN = {
    '元日' => "New Year's Day", '成人の日' => 'Coming of Age Day', '建国記念の日' => 'National Foundation Day',
    '天皇誕生日' => "Emperor's Birthday", '春分の日' => 'Vernal Equinox Day', '昭和の日' => 'Showa Day',
    '憲法記念日' => 'Constitution Day', 'みどりの日' => 'Greenery Day', 'こどもの日' => "Children's Day",
    '海の日' => 'Marine Day', '山の日' => 'Mountain Day', '敬老の日' => 'Respect for the Aged Day',
    '秋分の日' => 'Autumnal Equinox Day', 'スポーツの日' => 'Sports Day', '体育の日' => 'Health and Sports Day',
    '文化の日' => 'Culture Day', '勤労感謝の日' => 'Labor Thanksgiving Day', '天皇の即位の日' => 'Enthronement Day',
    '即位礼正殿の儀の行われる日' => 'Enthronement Ceremony Day', '国民の休日' => "Citizens' Holiday",
    '振替休日' => 'Substitute Holiday', '休日' => 'Holiday', '結婚の儀' => 'Imperial Wedding',
    '大喪の礼' => 'State Funeral of Emperor Showa', '即位礼正殿の儀' => 'Enthronement Ceremony'
  }.freeze
  # Years whose Japanese holidays are calculated: from the first full year of the law to the end of the equinox formula.
  # Other years have none (dates like 9999-12-31 for "no end" or year 3 for a typo stay valid).
  JP_YEARS = (1949..2150).freeze
  # [years, { spring:, autumn: }, base year of the leap-day correction]
  EQUINOX = [
    [(1900..1979), { spring: 20.8357, autumn: 23.2588 }, 1983],
    [(1980..2099), { spring: 20.8431, autumn: 23.2488 }, 1980],
    [(2100..2150), { spring: 21.8510, autumn: 24.2488 }, 1980]
  ].freeze
  SPECIAL_DAYS = {
    Date.new(1959, 4, 10) => '結婚の儀', Date.new(1989, 2, 24) => '大喪の礼', Date.new(1990, 11, 12) => '即位礼正殿の儀',
    Date.new(1993, 6, 9) => '結婚の儀', Date.new(2019, 5, 1) => '天皇の即位の日', Date.new(2019, 10, 22) => '即位礼正殿の儀の行われる日'
  }.freeze
  SUBSTITUTE_FROM = Date.new(1973, 4, 12)
  JP_HOLIDAYS = {} # rubocop:disable Style/MutableConstant -- per-year cache of jp_holidays
  # Date range searched for the n-th working day (Ruby's Date accepts far wider years)
  SEARCH_JD = (Date.new(-9999, 1, 1).jd..Date.new(19_999, 12, 31).jd).freeze

  def self.from_settings
    s = Gantrix::HolidaySource.settings
    source = Gantrix::HolidaySource.source(s)
    Gantrix::HolidaySource.refresh_later_if_stale if source == 'jp'
    extra = s['extra_holidays'].to_s.split(/\s+/).filter_map do |v|
      Date.iso8601(v)
    rescue ArgumentError
      nil
    end
    new(non_working_wdays: Array(Setting.non_working_week_days).map(&:to_i),
        source: source,
        jp_cache: Gantrix::HolidaySource.parse_list(s['jp_cache']),
        imported: Gantrix::HolidaySource.parse_list(s['imported_holidays']),
        extra_holidays: extra)
  end

  # non_working_wdays: ISO cwday (1 = Monday .. 7 = Sunday)
  # source: 'jp' (Cabinet Office CSV cache, calculated for years it lacks),
  #         'imported' (an imported CSV) or 'none'
  def initialize(non_working_wdays: [6, 7], source: 'jp', jp_cache: {}, imported: {}, extra_holidays: [])
    @non_working = non_working_wdays
    @source = source
    @jp_cache = jp_cache.group_by { |d, _| d.year }.transform_values(&:to_h)
    @imported = imported
    @extra = extra_holidays.to_h { |d| [d, COMPANY_HOLIDAY] }
    @cache = {}
    # working week days within one week, counted from the week day of Julian day 0
    offset = Date.jd(0).cwday
    week = Array.new(7) { |i| @non_working.exclude?(((offset + i - 1) % 7) + 1) }
    @week_days = week.count(true)
    @week_prefix = (0..7).map { |r| week.first(r).count(true) }
  end

  def holidays_between(from, to)
    (from.year..to.year).each_with_object({}) do |y, h|
      year_holidays(y).each { |d, name| h[d] = name if d.between?(from, to) }
    end
  end

  def holiday?(date)
    year_holidays(date.year).key?(date)
  end

  def working_day?(date)
    @non_working.exclude?(date.cwday) && !holiday?(date)
  end

  # (with every week day off there is no working day: the date is kept)
  def next_working_day(date)
    return date if @week_days.zero?

    date += 1 until working_day?(date)
    date
  end

  def prev_working_day(date)
    return date if @week_days.zero?

    date -= 1 until working_day?(date)
    date
  end

  # n working days strictly after (n > 0) or before (n < 0) +date+.
  def step(date, n)
    return date if n.zero? || @week_days.zero?

    nth_working_day(n.positive? ? working_days_through(date) + n : working_days_through(date - 1) + n + 1)
  end

  # Snap to a working day, then move n working days.
  def add_working_days(date, n)
    step(next_working_day(date), n)
  end

  # Inclusive count of working days (at least 1 so a task never vanishes).
  def working_days(from, to)
    return 1 if from.nil? || to.nil? || to < from

    [working_days_through(to) - working_days_through(from - 1), 1].max
  end

  # Number of working days up to and including +date+, counted from Julian day 0 (negative before it).
  # Week days by arithmetic and holidays by a binary search, so long periods cost no more than short ones.
  def working_days_through(date)
    j = date.jd + 1
    holidays = holiday_jds.bsearch_index { |h| h > date.jd } || holiday_jds.size
    (j.div(7) * @week_days) + @week_prefix[j % 7] - holidays
  end

  # Move a task so it starts on +new_start+ keeping its working duration.
  def shift_task(start_date, due_date, new_start)
    s = next_working_day(new_start)
    return [s, nil] unless due_date

    [s, step(s, working_days(start_date, due_date) - 1)]
  end

  def year_holidays(year)
    @cache[year] ||= year_holidays_with_origin(year).transform_values(&:first)
  end

  # { date => [name, origin] } where origin is :cao, :calculated, :imported or :company
  def year_holidays_with_origin(year)
    h = case @source
        when 'jp'
          cached = @jp_cache[year]
          cached ? cached.transform_values { |n| [n, :cao] } : self.class.jp_holidays(year).transform_values { |n| [n, :calculated] }
        when 'imported'
          @imported.select { |d, _| d.year == year }.transform_values { |n| [n, :imported] }
        else
          {}
        end
    @extra.each { |d, name| h[d] ||= [name, :company] if d.year == year }
    h
  end

  # Japanese public holidays under the rules of each year since the law of 1948, checked against the Cabinet
  # Office list (1955 onwards). None outside JP_YEARS. Pure, so the result is shared by every calendar.
  def self.jp_holidays(year)
    return {} unless JP_YEARS.cover?(year)

    JP_HOLIDAYS[year] ||= calculate_jp_holidays(year).freeze
  end

  def self.calculate_jp_holidays(year)
    h = {}
    nth_monday = lambda do |month, n|
      first = Date.new(year, month, 1)
      first + ((1 - first.cwday) % 7) + (7 * (n - 1))
    end
    add = ->(month, day, name) { h[day.is_a?(Date) ? day : Date.new(year, month, day)] = name }

    add.call(1, 1, '元日')
    add.call(1, year >= 2000 ? nth_monday.call(1, 2) : 15, '成人の日')
    add.call(2, 11, '建国記念の日') if year >= 1967
    add.call(2, 23, '天皇誕生日') if year >= 2020
    add.call(3, equinox_day(year, :spring), '春分の日')
    add.call(4, 29, if year >= 2007 then '昭和の日'
                    elsif year >= 1989 then 'みどりの日'
                    else '天皇誕生日'
                    end)
    add.call(5, 3, '憲法記念日')
    add.call(5, 4, 'みどりの日') if year >= 2007
    add.call(5, 5, 'こどもの日')
    case year
    when 2020
      add.call(7, 23, '海の日')
      add.call(7, 24, 'スポーツの日')
      add.call(8, 10, '山の日')
    when 2021
      add.call(7, 22, '海の日')
      add.call(7, 23, 'スポーツの日')
      add.call(8, 8, '山の日')
    else
      add.call(7, year >= 2003 ? nth_monday.call(7, 3) : 20, '海の日') if year >= 1996
      add.call(8, 11, '山の日') if year >= 2016
      if year >= 2000
        add.call(10, nth_monday.call(10, 2), year >= 2020 ? 'スポーツの日' : '体育の日')
      elsif year >= 1966
        add.call(10, 10, '体育の日')
      end
    end
    add.call(9, year >= 2003 ? nth_monday.call(9, 3) : 15, '敬老の日') if year >= 1966
    add.call(9, equinox_day(year, :autumn), '秋分の日')
    add.call(11, 3, '文化の日')
    add.call(11, 23, '勤労感謝の日')
    add.call(12, 23, '天皇誕生日') if year.between?(1989, 2018)
    SPECIAL_DAYS.each { |d, name| add.call(d.month, d, name) if d.year == year }

    # 国民の休日 (from 1986): a day other than Sunday between two national holidays
    if year >= 1986
      h.keys.sort.each_cons(2) do |a, b|
        mid = a + 1
        h[mid] = '国民の休日' if b - a == 2 && mid.cwday != 7
      end
    end
    # 振替休日 (from 1973-04-12): a national holiday on Sunday makes the next day a holiday;
    # from 2007 the next day that is not a holiday
    h.keys.sort.each do |d|
      next unless d.cwday == 7 && d >= SUBSTITUTE_FROM

      sub = d + 1
      sub += 1 while year >= 2007 && h.key?(sub)
      h[sub] ||= '振替休日'
    end
    h
  end

  # 春分の日 / 秋分の日: the usual approximation of the equinox, valid from 1900 to 2150
  def self.equinox_day(year, season)
    _, base, leap = EQUINOX.detect { |years, *| years.cover?(year) }
    # the correction is truncated toward zero (it is negative before 1983)
    (base[season] + (0.242194 * (year - 1980)) - ((year - leap) / 4.0).truncate).floor
  end

  private

  # Julian days of the holidays that fall on a working week day, sorted
  def holiday_jds
    @holiday_jds ||= begin
      years = JP_YEARS.to_a | @jp_cache.keys | @imported.keys.map(&:year) | @extra.keys.map(&:year)
      years.flat_map { |y| year_holidays(y).keys }.reject { |d| @non_working.include?(d.cwday) }.map(&:jd).uniq.sort
    end
  end

  # the first day whose count of working days reaches +k+
  def nth_working_day(k)
    Date.jd(SEARCH_JD.bsearch { |j| working_days_through(Date.jd(j)) >= k } || SEARCH_JD.last)
  end
end
