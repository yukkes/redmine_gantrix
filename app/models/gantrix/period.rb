# frozen_string_literal: true

# The period worth showing for a set of dates (the same rule as Gantrix.focusRange in core.js): dates far
# away from the others (9999-12-31 for "no end", year 3 for a typo) would stretch a chart or the earned value
# over thousands of years. The dates are split where they are more than two years apart; groups holding few
# of them (under 3 or under 10%) are left out unless they are the largest or +keep+ (today) is near them,
# and the result is at most +max_span+ days (five years for drawing a chart; nil for no limit), around +keep+
# when it is inside.
module Gantrix::Period
  GAP = 731
  MAX_SPAN = (365 * 5) + 1

  # [first, last] (Dates), or nil without dates and +keep+
  def self.focus(dates, keep = nil, max_span: MAX_SPAN)
    v = dates.compact.sort
    return keep && [keep, keep] if v.empty?

    groups = v.slice_when { |a, b| b - a > GAP }.map { |g| { lo: g.first, hi: g.last, n: g.size } }
    biggest = groups.max_by { |g| g[:n] }
    near = ->(g) { keep && keep >= g[:lo] - GAP && keep <= g[:hi] + GAP }
    kept = groups.select { |g| g.equal?(biggest) || near.call(g) || (g[:n] >= 3 && g[:n] >= v.size * 0.1) }
    lo = kept.pluck(:lo).min
    hi = kept.pluck(:hi).max
    if keep && keep >= lo - GAP && keep <= hi + GAP
      lo = [lo, keep].min
      hi = [hi, keep].max
    end
    if max_span && hi - lo > max_span
      c = keep && keep >= lo && keep <= hi ? keep : hi
      lo = (c - (max_span / 2)).clamp(lo, hi - max_span)
      hi = lo + max_span
    end
    [lo, hi]
  end
end
