/**
 * The room's live objects (docs/PALACE.md, Objects): which sessions have robots and where they
 * stand, what the mail tray, hearth, lamp and kettle show, and what each object's hover card says.
 * The scene's components draw from these; `RoomBackground` writes their summary into `data-room`
 * for tests. No React, no DOM, no three.js: the node test runner loads this file directly.
 */
import type { RoomWeather } from "@portal/contracts/room";
import type { LivenessState, SessionLink } from "@portal/contracts/types";
import { assignSlots, bucket, hashId, mulberry32 } from "@portal/shared/room";
import { sessionState, sessionStateLabels } from "@portal/shared/session-state";

// ---------------------------------------------------------------------------------------------
// Robots
// ---------------------------------------------------------------------------------------------

/** The session states that have a robot in the room (decision 22); finished and offline have none. */
export type RobotState = "connecting" | "working" | "background" | "approval" | "hung";

/** What the robot mapping reads from a session's list entry. */
export type RobotSession = {
  id: string;
  title: string | null;
  agentId: string;
  agentName: string;
  createdAt: number;
  busy: boolean;
  awaitingPermission: boolean;
  link?: SessionLink | null;
  liveness?: LivenessState | null;
};

/**
 * The robot for a session, by the one session state every view shares (`sessionState`): connecting,
 * working, background, approval and hung have one; finished and offline do not (the robot walks out).
 */
export function robotStateFor(session: Pick<RobotSession, "busy" | "awaitingPermission" | "link" | "liveness">): RobotState | null {
  const state = sessionState(session);
  switch (state) {
    case "connecting":
    case "working":
    case "background":
    case "approval":
    case "hung":
      return state;
    default:
      return null;
  }
}

/** Robots placed in the room; the rest queue by the door. */
export const ROBOT_CAP = 8;
/** Queued robots drawn in the line by the door; any more are only counted in the hover card. */
export const QUEUE_DRAWN = 4;

/** Where a robot stands: at the bench on the rug, by the door (waiting on you), or in the queue. */
export type RobotPlace = "bench" | "door" | "queue";

export type RobotSpec = {
  id: string;
  state: RobotState;
  place: RobotPlace;
  /** The bench or door slot (0..ROBOT_CAP-1), or the place in the queue. */
  slot: number;
  title: string;
  agentId: string;
  agentName: string;
  tracked: boolean;
};

export type RobotCrowd = {
  /** Robots drawn: every placed one, then the first `QUEUE_DRAWN` of the queue. */
  robots: RobotSpec[];
  /** Every session with a robot, drawn or not. */
  total: number;
  /** How many wait in the queue by the door (drawn or not). */
  queued: number;
};

/**
 * One robot per active session (docs/PALACE.md, Objects). Oldest session first: the first eight are
 * placed (approval ones by the door, in order; the rest at the bench, in a slot from the session
 * id's hash so a newcomer never moves another), and the rest queue by the door.
 */
export function placeRobots(sessions: readonly RobotSession[], tracked: ReadonlySet<string> = new Set()): RobotCrowd {
  const active = sessions
    .map((session) => ({ session, state: robotStateFor(session) }))
    .filter((entry): entry is { session: RobotSession; state: RobotState } => entry.state !== null)
    .sort((a, b) => a.session.createdAt - b.session.createdAt || (a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0));
  const placed = active.slice(0, ROBOT_CAP);
  const waiting = active.slice(ROBOT_CAP);
  const benchIds = placed.filter((entry) => entry.state !== "approval").map((entry) => entry.session.id);
  const slots = assignSlots(benchIds, ROBOT_CAP);
  const benchSlots = new Map(benchIds.map((id, index) => [id, slots[index]]));
  let door = 0;
  const spec = (session: RobotSession, state: RobotState, place: RobotPlace, slot: number): RobotSpec => ({
    id: session.id,
    state,
    place,
    slot,
    title: session.title || "New conversation",
    agentId: session.agentId,
    agentName: session.agentName,
    tracked: tracked.has(session.id),
  });
  const robots = placed.map(({ session, state }) =>
    state === "approval" ? spec(session, state, "door", door++) : spec(session, state, "bench", benchSlots.get(session.id) ?? 0),
  );
  waiting.slice(0, QUEUE_DRAWN).forEach(({ session, state }, index) => robots.push(spec(session, state, "queue", index)));
  return { robots, total: active.length, queued: waiting.length };
}

/** A robot's looks, all from its session id's hash: body colour, head shape, antenna, and the antenna tip's colour. */
export type RobotLook = { body: string; head: 0 | 1 | 2; antenna: 0 | 1 | 2; tip: string; scarf: string };

const BODIES = ["#9cc5d6", "#e9b6a0", "#b9d39a", "#e6d38f", "#c3b2de", "#f0c4cf", "#a9d6c4", "#d8c0a2"] as const;
const TIPS = ["#ff8a65", "#ffd54f", "#81d4fa", "#a5d6a7", "#f48fb1"] as const;
const SCARVES = ["#c8463c", "#3f6fb0", "#d9902f", "#5d8a4a"] as const;

export function robotLook(id: string): RobotLook {
  const random = mulberry32(hashId(id, 17));
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length) % list.length];
  return {
    body: pick(BODIES),
    head: (Math.floor(random() * 3) % 3) as 0 | 1 | 2,
    antenna: (Math.floor(random() * 3) % 3) as 0 | 1 | 2,
    tip: pick(TIPS),
    scarf: pick(SCARVES),
  };
}

/** The badge's colour for an agent kind: the known agents' own hues, any other from its id's hash. */
export function agentBadge(agentId: string): string {
  const known: Record<string, string> = { claude: "#d97757", codex: "#4c6fdc", gemini: "#4b8ff0", cursor: "#7a7a90", opencode: "#e0a030" };
  return known[agentId] ?? TIPS[hashId(agentId) % TIPS.length];
}

/** Room coordinates (metres, floor at y 0) of the places robots stand and walk through: x right, z towards the camera. */
export const SPOTS = {
  /** In the hallway behind the door, out of sight. */
  outside: [3.35, -4.1] as const,
  /** Just inside the door. */
  inside: [3.35, -2.35] as const,
  /** The bench's centre on the rug; robots work behind it, facing the camera. */
  bench: [0.3, 0.6] as const,
} as const;

/** The floor position `[x, z]` of a robot's slot. */
export function robotSpot(place: RobotPlace, slot: number): [number, number] {
  if (place === "bench") return [SPOTS.bench[0] + (slot - (ROBOT_CAP - 1) / 2) * 0.36, SPOTS.bench[1] - 0.32];
  if (place === "door") return [2.95 - (slot % 4) * 0.4, -1.75 + Math.floor(slot / 4) * 0.45];
  return [3.8, -2.0 + slot * 0.4];
}

/** "8 at the bench, 3 more queued by the door", or the plain count. */
export function robotsLabel(total: number): string {
  if (total > ROBOT_CAP) return `${ROBOT_CAP} sessions in the room, ${total - ROBOT_CAP} more queued by the door`;
  return `${total} active ${total === 1 ? "session" : "sessions"} in the room`;
}

export const robotStateLabels: Record<RobotState, string> = {
  connecting: sessionStateLabels.connecting,
  working: sessionStateLabels.working,
  background: "Working in the background",
  approval: sessionStateLabels.approval,
  hung: sessionStateLabels.hung,
};

// ---------------------------------------------------------------------------------------------
// The mail tray, the hearth, the lamp, the kettle
// ---------------------------------------------------------------------------------------------

/** Envelopes stacked in the tray before the rest go on a pile. */
export const MAIL_CAP = 12;

/** The tray's envelopes: sealed ones (pending approvals) first, then open ones (needs-you items), up to twelve; the rest on the pile. */
export function mailStack(needsYou: number, approvals: number): { sealed: number; open: number; pile: number } {
  const sealed = Math.max(0, Math.floor(approvals));
  const open = Math.max(0, Math.floor(needsYou));
  const { shown, extra } = bucket(sealed + open, MAIL_CAP);
  const sealedShown = Math.min(sealed, shown);
  return { sealed: sealedShown, open: shown - sealedShown, pile: extra };
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The tray's hover card lines: what is in it, and the pile's number past twelve. */
export function mailLabel(needsYou: number, approvals: number): string[] {
  const { pile } = mailStack(needsYou, approvals);
  const lines = [count(needsYou, "item needs you", "items need you"), count(approvals, "approval waits (sealed)", "approvals wait (sealed)")];
  if (pile > 0) lines.push(`${MAIL_CAP} in the tray and a pile of ${pile} more`);
  return lines;
}

export type HearthLevel = "cold" | "embers" | "fire";

/** Cold under 3 Activity entries in the last hour, embers up to 20, a full fire past that. */
export function hearthLevel(activityLastHour: number): HearthLevel {
  if (activityLastHour < 3) return "cold";
  if (activityLastHour <= 20) return "embers";
  return "fire";
}

export type LampState = "on" | "dim" | "off";

export const LAMP_OFF_AFTER_MS = 60 * 60_000;

/** On during a chat turn; a dim glow when idle; off at night once Portal has been idle for an hour. */
export function lampState({ busy, night, idleSince, now }: { busy: boolean; night: boolean; idleSince: number; now: number }): LampState {
  if (busy) return "on";
  if (night && now - idleSince >= LAMP_OFF_AFTER_MS) return "off";
  return "dim";
}

/** A run in progress, as the stream's status lists it. */
export type LiveRun = { id: string; kind: string; summary: string | null };

/** The background job runs in progress (chat turns are the lamp's): the kettle steams while there is one. */
export function backgroundRuns<T extends LiveRun>(runs: readonly T[]): T[] {
  return runs.filter((run) => run.kind !== "chat");
}

const RUN_KINDS: Record<string, string> = {
  tick: "a check-in",
  intent_check: "a watch check",
  helper: "a helper",
  consolidate: "memory curation",
};

// ---------------------------------------------------------------------------------------------
// Hover cards
// ---------------------------------------------------------------------------------------------

export type RoomObjectKind = "robot" | "mail" | "hearth" | "kettle" | "lamp" | "window";
export type RoomTarget = { kind: RoomObjectKind; id: string };

/** What the room knows right now, for the cards. */
export type RoomLiveData = {
  crowd: RobotCrowd;
  needsYou: number;
  approvals: number;
  activityLastHour: number;
  runs: readonly LiveRun[];
  busy: boolean;
  lamp: LampState;
  weather: RoomWeather | null;
};

export type RoomCard = {
  title: string;
  /** What the object stands for. */
  about: string;
  lines: string[];
  /** Where a click goes, in words ("Click to open the session"); null for the window (card only). */
  hint: string | null;
  /** The phone card's button. */
  action: string | null;
  /** The window's card carries the weather provider's credit link. */
  credit: boolean;
};

const CONDITIONS: Record<RoomWeather["condition"], string> = {
  clear: "Clear",
  "partly-cloudy": "Partly cloudy",
  overcast: "Overcast",
  fog: "Fog",
  drizzle: "Drizzle",
  rain: "Rain",
  "heavy-rain": "Heavy rain",
  snow: "Snow",
  thunderstorm: "Thunderstorm",
};

/** The hover card for an object; null when it is gone (a robot that just walked out). */
export function describeObject(target: RoomTarget, data: RoomLiveData): RoomCard | null {
  const card = (title: string, about: string, lines: string[], where: string | null): RoomCard => ({
    title,
    about,
    lines,
    hint: where ? `Click to open ${where}` : null,
    action: where ? `Open ${where}` : null,
    credit: false,
  });
  switch (target.kind) {
    case "robot": {
      const robot = data.crowd.robots.find((each) => each.id === target.id);
      if (!robot) return null;
      const lines = [`${robotStateLabels[robot.state]} · ${robot.agentName}`];
      if (robot.place === "queue") lines.push("Queued by the door: the room holds eight");
      if (robot.tracked) lines.push("Tracked (the scarf)");
      lines.push(robotsLabel(data.crowd.total));
      return card(robot.title, "A session's robot", lines, "the session");
    }
    case "mail":
      return card("Mail tray", "Needs you: one envelope per item, a sealed one per approval", mailLabel(data.needsYou, data.approvals), "Needs you");
    case "hearth": {
      const level = hearthLevel(data.activityLastHour);
      const state = level === "cold" ? "Cold (under 3)" : level === "embers" ? "Embers (up to 20)" : "A full fire (past 20)";
      return card("Hearth", "Activity in the last hour", [count(data.activityLastHour, "entry", "entries"), state], "Activity");
    }
    case "kettle": {
      const jobs = backgroundRuns(data.runs);
      const lines = jobs.length
        ? [`Steaming: ${count(jobs.length, "job", "jobs")} running`, ...jobs.slice(0, 3).map((run) => run.summary ?? RUN_KINDS[run.kind] ?? run.kind)]
        : ["Quiet: no background job is running"];
      return card("Kettle", "Portal's background jobs", lines, "the jobs");
    }
    case "lamp":
      return card(
        "Desk lamp",
        "Portal at its desk",
        [data.busy ? "On: Portal is answering" : data.lamp === "off" ? "Off: idle for over an hour at night" : "A dim glow: Portal is idle"],
        "Talk to Portal",
      );
    case "window": {
      const weather = data.weather;
      const lines = weather
        ? [`${CONDITIONS[weather.condition]}, ${Math.round(weather.temperature)}°C`, weather.isDay ? "Day" : "Night"]
        : ["The weather is not known yet"];
      return { title: "Window", about: "The sun and the weather where the room is", lines, hint: null, action: null, credit: true };
    }
  }
}

/** The `data-room` summary of the live objects, for tests: robots with their state and place, the tray, the hearth, lamp, kettle. */
export function liveSummary(data: RoomLiveData) {
  return {
    robots: data.crowd.robots.map(({ id, state, place }) => ({ id, state, place })),
    queued: data.crowd.queued,
    mail: mailStack(data.needsYou, data.approvals),
    hearth: hearthLevel(data.activityLastHour),
    lamp: data.lamp,
    kettle: backgroundRuns(data.runs).length > 0,
  };
}
