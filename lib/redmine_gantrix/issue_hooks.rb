# frozen_string_literal: true

module RedmineGantrix
  # Adds a callback to Issue (no core method is overridden): when a task becomes done,
  # notify the assignees of successors that can now start.
  module IssueHooks
    extend ActiveSupport::Concern

    included do
      after_commit :gantrix_after_done, on: :update
    end

    private

    def gantrix_after_done
      became_closed = saved_change_to_status_id? && closed? && !IssueStatus.find_by(id: status_id_before_last_save)&.is_closed?
      became_full = saved_change_to_done_ratio? && done_ratio.to_i >= 100 && !closed?
      Gantrix::Notifier.predecessor_done(self) if became_closed || became_full
    rescue StandardError => e
      Rails.logger.warn("[gantrix] successor notification failed: #{e.class}: #{e.message}")
    end
  end
end
