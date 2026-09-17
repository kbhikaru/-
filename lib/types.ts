export type Slot = {
  /** ISO 8601, UTC */
  startISO: string;
  /** ISO 8601, UTC */
  endISO: string;
};

export type CalendarSource = {
  url: string;
  label?: string;
};

export type CalendarResult = {
  url: string;
  label: string;
  timeZone: string | null;
  slots: Slot[];
  error?: string;
};

export type ScrapeRequest = {
  sources: CalendarSource[];
  /** How many days ahead to look, from today. */
  days: number;
};

export type ScrapeResponse = {
  calendars: CalendarResult[];
  common: Slot[];
};
