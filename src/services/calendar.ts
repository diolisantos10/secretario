/** Operações de agenda (Google Calendar). */
import { google } from "googleapis";
import { authedClient, isConnected } from "./googleAuth";
import { todayBounds, TZ } from "../util/datetime";

export { isConnected };

export interface CalEvent {
  id: string;
  summary: string;
  start: string; // ISO ou data
  end: string;
  location?: string;
}

function mapEvent(e: any): CalEvent {
  return {
    id: e.id ?? "",
    summary: e.summary ?? "(sem título)",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    location: e.location ?? undefined,
  };
}

/** Lista eventos entre timeMin e timeMax (ISO 8601). */
export async function listEvents(timeMin: string, timeMax: string): Promise<CalEvent[]> {
  const auth = await authedClient();
  if (!auth) throw new Error("AGENDA_NAO_CONECTADA");
  const cal = google.calendar({ version: "v3", auth });
  const res = await cal.events.list({
    calendarId: "primary",
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 25,
  });
  return (res.data.items ?? []).map(mapEvent);
}

/** Eventos de hoje (no fuso do dono). */
export async function listToday(): Promise<CalEvent[]> {
  const { start, end } = todayBounds();
  return listEvents(start.toISOString(), end.toISOString());
}

/** Cria um evento. Se `end` faltar, dura 1h. */
export async function createEvent(input: {
  summary: string;
  start: string;
  end?: string;
  description?: string;
  location?: string;
}): Promise<CalEvent> {
  const auth = await authedClient();
  if (!auth) throw new Error("AGENDA_NAO_CONECTADA");
  const cal = google.calendar({ version: "v3", auth });

  const startDate = new Date(input.start);
  const endIso = input.end ?? new Date(startDate.getTime() + 60 * 60 * 1000).toISOString();

  const res = await cal.events.insert({
    calendarId: "primary",
    requestBody: {
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: { dateTime: new Date(input.start).toISOString(), timeZone: TZ },
      end: { dateTime: new Date(endIso).toISOString(), timeZone: TZ },
    },
  });
  return mapEvent(res.data);
}
