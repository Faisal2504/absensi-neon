"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";

type RoleType = "ADMIN" | "MANAGER" | "STAFF";
type ServerMode = "ADMIN" | "MANAGER" | "KARYAWAN";
type ShiftCode = "P" | "S" | "M" | "OFF";
type DayKey = "Senin" | "Selasa" | "Rabu" | "Kamis" | "Jumat" | "Sabtu" | "Minggu";

type WeeklyScheduleMap = Record<DayKey, ShiftCode>;

interface DeviceSystemInfo {
  device_id: string;
  os_platform: string;
  device_model: string;
  browser: string;
  screen_size: string;
  timezone: string;
  summary: string;
  logged_in_at?: string;
}

interface Employee {
  id: number;
  emp_code: string;
  full_name: string;
  role: RoleType;
  department: string;
  pin_code: string;
  shift_start_time?: string;
  weekly_schedule?: WeeklyScheduleMap;
  last_device?: DeviceSystemInfo | null;
}

interface LocationItem {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
}

interface TimeEntry {
  id?: number;
  client_uuid: string;
  employee_id: number;
  entry_type: "CLOCK_IN" | "CLOCK_OUT";
  punched_at: string;
  is_offline_sync?: boolean;
  qr_code?: string;
  mode?: string;
  notes?: string;
  latitude?: number | null;
  longitude?: number | null;
  distance_meters?: number | null;
  is_within_geofence?: boolean;
  selfie_data?: string | null;
  face_detected?: boolean;
  full_name?: string;
  emp_code?: string;
  device_info?: string;
}

interface ParsedScheduleItem {
  emp_code: string;
  full_name: string;
  shift_code: ShiftCode;
  shift_label: string;
  shift_time: string;
  weekly?: Partial<WeeklyScheduleMap>;
}

interface UploadedSchedulePoster {
  fileName: string;
  uploadedAt: string;
  uploadedBy: string;
  imageDataUrl: string;
  pdfDataUrl?: string;
  summaryRows: ParsedScheduleItem[];
}

interface FaceDetectorInstance {
  detect: (
    image: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement
  ) => Promise<Array<{ boundingBox: DOMRectReadOnly }>>;
}

interface BarcodeDetectorInstance {
  detect: (
    video: HTMLVideoElement
  ) => Promise<Array<{ rawValue?: string; raw_value?: string }>>;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const APP_LOGO_SRC = "/fast-absensi-pro-mfr.png";

const DEFAULT_LAT = -6.9148609;
const DEFAULT_LNG = 109.744683;
const DEFAULT_RADIUS = 2000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const LATE_GRACE_MINUTES = 5;

const LOCKED_STAFF_CODES = [
  "AP-SCRTY-MPI.22112026.0001",
  "DDS-SCRTY-MPI.22112026.0002",
  "JRA-SCRTY-MPI.22112026.0003",
  "LJ-SCRTY-MPI.22112026.0004",
] as const;

const DAYS_OF_WEEK: DayKey[] = [
  "Senin",
  "Selasa",
  "Rabu",
  "Kamis",
  "Jumat",
  "Sabtu",
  "Minggu",
];

const SHIFT_PRESETS: Record<
  ShiftCode,
  { code: ShiftCode; name: string; start: string; end: string; rangeLabel: string }
> = {
  P: {
    code: "P",
    name: "Pagi",
    start: "07.00",
    end: "15.00",
    rangeLabel: "07.00 - 15.00",
  },
  S: {
    code: "S",
    name: "Siang",
    start: "15.00",
    end: "23.00",
    rangeLabel: "15.00 - 23.00",
  },
  M: {
    code: "M",
    name: "Malam",
    start: "23.00",
    end: "07.00",
    rangeLabel: "23.00 - 07.00",
  },
  OFF: {
    code: "OFF",
    name: "Libur",
    start: "OFF",
    end: "OFF",
    rangeLabel: "LIBUR (OFF)",
  },
};

const SHIFT_OPTIONS = [
  { label: "( P ) Pagi • 07.00 - 15.00", time: "07.00", code: "P" as ShiftCode },
  { label: "( S ) Siang • 15.00 - 23.00", time: "15.00", code: "S" as ShiftCode },
  { label: "( M ) Malam • 23.00 - 07.00", time: "23.00", code: "M" as ShiftCode },
  { label: "( OFF ) Libur", time: "OFF", code: "OFF" as ShiftCode },
];

const CACHE_KEY = "absensi_v12_cache";
const QUEUE_KEY = "absensi_v12_queue";
const QR_CODE_KEY = "absensi_v12_qr";
const LOC_KEY = "absensi_v12_custom_loc";
const WEEKLY_SCHED_KEY = "absensi_v12_weekly_sched";
const SCHEDULE_POSTER_KEY = "absensi_v12_schedule_poster";
const DEVICE_LOCK_KEY = "absensi_v12_device_locked_karyawan";
const STAFF_EMP_KEY = "absensi_v12_staff_emp_id";
const STAFF_EMP_CODE_KEY = "absensi_v12_staff_emp_code";
const STAFF_SESSION_KEY = "absensi_v12_staff_logged_in";
const DEVICE_REG_KEY = "absensi_v12_device_registry";
const AUTH_SERVER_KEY = "absensi_v12_auth_server";

function collectHpDeviceSystemInfo(loggedInAt?: string): DeviceSystemInfo {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return {
      device_id: "SRV-DEFAULT",
      os_platform: "Unknown",
      device_model: "Perangkat HP",
      browser: "Browser",
      screen_size: "0x0",
      timezone: "Asia/Jakarta",
      summary: "Perangkat HP • Asia/Jakarta",
      logged_in_at: loggedInAt,
    };
  }

  let deviceId = "";
  try {
    deviceId = localStorage.getItem("absensi_v12_hw_id") || "";
    if (!deviceId) {
      deviceId = `HP-${Math.random().toString(36).slice(2, 7).toUpperCase()}-${Date.now()
        .toString(36)
        .slice(-4)
        .toUpperCase()}`;
      localStorage.setItem("absensi_v12_hw_id", deviceId);
    }
  } catch {
    deviceId = "HP-LOCAL";
  }

  const ua = navigator.userAgent || "";
  let osPlatform = navigator.platform || "Mobile";
  if (/android/i.test(ua)) {
    const ver = ua.match(/Android\s+([\d.]+)/i)?.[1];
    osPlatform = ver ? `Android ${ver}` : "Android";
  } else if (/iphone|ipad|ipod/i.test(ua)) {
    const ver = ua.match(/OS\s+([\d_]+)/i)?.[1]?.replace(/_/g, ".");
    osPlatform = ver ? `iOS ${ver}` : "iOS";
  } else if (/windows/i.test(ua)) {
    osPlatform = "Windows";
  } else if (/mac os/i.test(ua)) {
    osPlatform = "macOS";
  }

  let deviceModel = "Smartphone";
  if (/iphone/i.test(ua)) deviceModel = "iPhone";
  else if (/ipad/i.test(ua)) deviceModel = "iPad";
  else if (/android/i.test(ua)) {
    const modelMatch = ua.match(/;\s*([^;)]+)\s+Build\//i);
    deviceModel = modelMatch?.[1]?.trim() || "Android HP";
  }

  let browser = "Browser";
  if (/edg/i.test(ua)) browser = "Edge";
  else if (/opr|opera/i.test(ua)) browser = "Opera";
  else if (/chrome|crios/i.test(ua)) browser = "Chrome";
  else if (/firefox|fxios/i.test(ua)) browser = "Firefox";
  else if (/safari/i.test(ua)) browser = "Safari";

  const screenSize = `${window.screen?.width || 0}x${window.screen?.height || 0}`;
  const timezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Jakarta";

  return {
    device_id: deviceId,
    os_platform: osPlatform,
    device_model: deviceModel,
    browser,
    screen_size: screenSize,
    timezone,
    summary: `${deviceModel} (${osPlatform} • ${browser} • ${deviceId})`,
    logged_in_at: loggedInAt,
  };
}

function loadDeviceRegistry(): Record<string, DeviceSystemInfo> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(DEVICE_REG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function loadSchedulePoster(): UploadedSchedulePoster | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SCHEDULE_POSTER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.imageDataUrl) {
      return parsed as UploadedSchedulePoster;
    }
  } catch {
    // Abaikan
  }
  return null;
}

function buildDefaultWeeklySchedule(defaultCode: ShiftCode = "P"): WeeklyScheduleMap {
  return {
    Senin: defaultCode,
    Selasa: defaultCode,
    Rabu: defaultCode,
    Kamis: defaultCode,
    Jumat: defaultCode,
    Sabtu: defaultCode,
    Minggu: "OFF",
  };
}

function sanitizeWeeklySchedule(
  raw: unknown,
  fallbackCode: ShiftCode = "P"
): WeeklyScheduleMap {
  const base = buildDefaultWeeklySchedule(fallbackCode);
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Record<string, unknown>;
  DAYS_OF_WEEK.forEach((day) => {
    const val = String(obj[day] || "").trim().toUpperCase();
    if (val === "P" || val === "S" || val === "M" || val === "OFF") {
      base[day] = val as ShiftCode;
    }
  });
  return base;
}

function shiftTimeToCode(raw?: string | null): ShiftCode {
  const s = String(raw || "").trim().toUpperCase();
  if (s === "OFF" || s.includes("LIBUR")) return "OFF";
  if (s === "S" || s.includes("15.00") || s.includes("15:00") || s.includes("SIANG")) return "S";
  if (s === "M" || s.includes("23.00") || s.includes("23:00") || s.includes("MALAM")) return "M";
  return "P";
}

function shiftCodeToStartTime(code: ShiftCode): string {
  return SHIFT_PRESETS[code]?.start || "07.00";
}

function shiftCodeToLabel(code: ShiftCode): string {
  if (code === "OFF") return "OFF (Libur)";
  const p = SHIFT_PRESETS[code];
  return `( ${code} ) ${p.name} • ${p.rangeLabel}`;
}

function normalizeShiftTime(raw?: string | null): string {
  const s = String(raw || "").trim();
  if (!s) return "07.00";
  const upper = s.toUpperCase();
  const lower = s.toLowerCase();
  if (
    upper === "OFF" ||
    lower.includes("libur") ||
    lower.includes("off") ||
    lower.includes("flex") ||
    lower.includes("fleks")
  ) {
    return "OFF";
  }
  if (s.includes("15:00") || s.includes("15.00") || lower.includes("siang") || upper === "S") {
    return "15.00";
  }
  if (s.includes("23:00") || s.includes("23.00") || lower.includes("malam") || upper === "M") {
    return "23.00";
  }
  if (s.includes("07:00") || s.includes("07.00") || lower.includes("pagi") || upper === "P") {
    return "07.00";
  }
  return s.replace(":", ".");
}

function normalizeRole(raw?: string | null): RoleType {
  const r = String(raw || "STAFF").toUpperCase();
  if (r === "ADMIN") return "ADMIN";
  if (r === "MANAGER") return "MANAGER";
  return "STAFF";
}

function normalizeEntryType(raw?: string | null): "CLOCK_IN" | "CLOCK_OUT" {
  const t = String(raw || "CLOCK_IN").toUpperCase();
  return t === "CLOCK_OUT" || t === "OUT" ? "CLOCK_OUT" : "CLOCK_IN";
}

function getJakartaDayKey(iso?: string): DayKey {
  const dayStr = new Date(iso || new Date().toISOString()).toLocaleDateString("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
  });
  const lower = dayStr.toLowerCase();
  if (lower.includes("senin")) return "Senin";
  if (lower.includes("selasa")) return "Selasa";
  if (lower.includes("rabu")) return "Rabu";
  if (lower.includes("kamis")) return "Kamis";
  if (lower.includes("jumat") || lower.includes("jum'at")) return "Jumat";
  if (lower.includes("sabtu")) return "Sabtu";
  return "Minggu";
}

function getEmployeeShiftForIso(emp: Employee | undefined, iso: string): {
  code: ShiftCode;
  startTime: string;
  rangeLabel: string;
} {
  const dayKey = getJakartaDayKey(iso);
  const code: ShiftCode =
    emp?.weekly_schedule?.[dayKey] || shiftTimeToCode(emp?.shift_start_time);
  const preset = SHIFT_PRESETS[code];
  return {
    code,
    startTime: preset.start,
    rangeLabel: preset.rangeLabel,
  };
}

const DEFAULT_EMPLOYEES: Employee[] = [
  {
    id: 1,
    emp_code: "ADM-001",
    full_name: "Admin Operasional",
    role: "ADMIN",
    department: "Administrator",
    pin_code: "0000",
    shift_start_time: "07.00",
    weekly_schedule: buildDefaultWeeklySchedule("P"),
  },
  {
    id: 2,
    emp_code: "MGR-001",
    full_name: "Manager Operasional",
    role: "MANAGER",
    department: "Manajemen",
    pin_code: "2026",
    shift_start_time: "07.00",
    weekly_schedule: buildDefaultWeeklySchedule("P"),
  },
  {
    id: 3,
    emp_code: "AP-SCRTY-MPI.22112026.0001",
    full_name: "ANGGAR PERMADI",
    role: "STAFF",
    department: "Security Dormitory Batang",
    pin_code: "1001",
    shift_start_time: "07.00",
    weekly_schedule: buildDefaultWeeklySchedule("P"),
  },
  {
    id: 4,
    emp_code: "DDS-SCRTY-MPI.22112026.0002",
    full_name: "DANAR SETIAN SUGIYANTO",
    role: "STAFF",
    department: "Security Dormitory Batang",
    pin_code: "0002",
    shift_start_time: "15.00",
    weekly_schedule: buildDefaultWeeklySchedule("S"),
  },
  {
    id: 5,
    emp_code: "JRA-SCRTY-MPI.22112026.0003",
    full_name: "JULDA REKSA ADI",
    role: "STAFF",
    department: "Security Dormitory Batang",
    pin_code: "0003",
    shift_start_time: "23.00",
    weekly_schedule: buildDefaultWeeklySchedule("M"),
  },
  {
    id: 6,
    emp_code: "LJ-SCRTY-MPI.22112026.0004",
    full_name: "LATIF JUNIYANTON",
    role: "STAFF",
    department: "Security Dormitory Batang",
    pin_code: "0004",
    shift_start_time: "07.00",
    weekly_schedule: buildDefaultWeeklySchedule("P"),
  },
];

function ensureLockedEmployees(
  list: Employee[],
  weeklyMap: Record<string, WeeklyScheduleMap>,
  devReg: Record<string, DeviceSystemInfo>
): Employee[] {
  const normalized: Employee[] = list.map((e) => {
    const empCodeClean = String(e.emp_code || "").trim().toUpperCase();
    const defCode = shiftTimeToCode(e.shift_start_time);
    const resolvedSchedule = sanitizeWeeklySchedule(
      e.weekly_schedule || weeklyMap[empCodeClean],
      defCode
    );
    return {
      ...e,
      emp_code: empCodeClean,
      role: normalizeRole(e.role),
      shift_start_time: normalizeShiftTime(e.shift_start_time),
      weekly_schedule: resolvedSchedule,
      last_device: e.last_device || devReg[empCodeClean] || null,
    };
  });

  LOCKED_STAFF_CODES.forEach((lockedCode, idx) => {
    const exists = normalized.some(
      (emp) => emp.emp_code.toUpperCase() === lockedCode
    );
    if (!exists) {
      const seed = DEFAULT_EMPLOYEES[idx + 2];
      const defCode = shiftTimeToCode(seed?.shift_start_time);
      normalized.push({
        ...seed,
        id: seed?.id || 100 + idx,
        emp_code: lockedCode,
        weekly_schedule: sanitizeWeeklySchedule(
          weeklyMap[lockedCode] || seed?.weekly_schedule,
          defCode
        ),
        last_device: devReg[lockedCode] || null,
      });
    }
  });

  return normalized;
}

const DEFAULT_LOCATIONS: LocationItem[] = [
  {
    id: 1,
    name: "Kantor Utama",
    latitude: DEFAULT_LAT,
    longitude: DEFAULT_LNG,
    radius_meters: DEFAULT_RADIUS,
  },
];

const getJakartaDateStr = (iso?: string) =>
  new Date(iso || new Date().toISOString()).toLocaleDateString("en-CA", {
    timeZone: "Asia/Jakarta",
  });

const formatTimeWIB = (iso?: string | null) =>
  !iso
    ? "-"
    : new Date(iso).toLocaleTimeString("id-ID", {
        timeZone: "Asia/Jakarta",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

const formatFullTimestampWIB = (ms: number) =>
  new Date(ms).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }) + " WIB";

const formatDateTimeLocalWIB = (iso?: string | null) => {
  if (!iso) return "";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(new Date(iso))
    .replace(" ", "T");
};

function getWibMinutesOfDay(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date(iso))
    .split(":");
  return Number(parts[0]) * 60 + Number(parts[1]);
}

function getEffectiveShiftStartMinutes(
  punchedIso: string,
  shiftStart = "07.00"
): number | null {
  const norm = normalizeShiftTime(shiftStart);
  if (norm === "OFF") return null;

  if (norm === "07.00" || norm === "15.00" || norm === "23.00") {
    const fixedShifts = [
      { label: "07.00", min: 7 * 60 },
      { label: "15.00", min: 15 * 60 },
      { label: "23.00", min: 23 * 60 },
    ];
    const matched = fixedShifts.find((s) => s.label === norm) || fixedShifts[0];
    return matched.min;
  }

  const [sh, sm] = norm.replace(".", ":").split(":").map(Number);
  if (isNaN(sh)) return getWibMinutesOfDay(punchedIso);
  return sh * 60 + (isNaN(sm) ? 0 : sm);
}

function calcLateDetail(
  punchedIso: string,
  shiftStart = "07.00"
): {
  rawDiffMinutes: number;
  lateMinutes: number;
  isLate: boolean;
  statusNote: string;
} {
  const shiftMin = getEffectiveShiftStartMinutes(punchedIso, shiftStart);
  if (shiftMin === null) {
    return {
      rawDiffMinutes: 0,
      lateMinutes: 0,
      isLate: false,
      statusNote: "Jadwal Libur (OFF)",
    };
  }
  const actualMin = getWibMinutesOfDay(punchedIso);
  const diff = Math.max(0, actualMin - shiftMin);
  if (diff > LATE_GRACE_MINUTES) {
    return {
      rawDiffMinutes: diff,
      lateMinutes: diff,
      isLate: true,
      statusNote: `Terlambat ${diff} menit dari jam masuk ${shiftStart} (batas toleransi 5 menit terlewati)`,
    };
  }
  if (diff > 0) {
    return {
      rawDiffMinutes: diff,
      lateMinutes: 0,
      isLate: false,
      statusNote: `Tepat waktu (selisih ${diff} menit, masih dalam toleransi 5 menit)`,
    };
  }
  return {
    rawDiffMinutes: 0,
    lateMinutes: 0,
    isLate: false,
    statusNote: "Tepat waktu",
  };
}

function unlockAudioContext() {
  if (typeof window === "undefined") return;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    if (ctx.state === "suspended") {
      void ctx.resume();
    }
  } catch {
    // Abaikan
  }
}

function speakIndonesian(text: string) {
  if (typeof window === "undefined") return;
  try {
    if (!("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    synth.cancel();

    const runSpeak = () => {
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = "id-ID";
      utter.volume = 1;
      utter.rate = 0.96;
      utter.pitch = 1.15;

      const voices = synth.getVoices();
      const femaleIdVoice =
        voices.find(
          (v) =>
            v.lang.toLowerCase().startsWith("id") &&
            /female|wanita|gadis|siti|damayanti|ayu|nina|amelia/i.test(v.name)
        ) ||
        voices.find((v) => v.lang.toLowerCase().startsWith("id")) ||
        voices.find((v) =>
          /female|wanita|google bahasa indonesia/i.test(v.name)
        );

      if (femaleIdVoice) {
        utter.voice = femaleIdVoice;
      }
      synth.speak(utter);
    };

    if (synth.getVoices().length === 0) {
      synth.onvoiceschanged = () => {
        synth.onvoiceschanged = null;
        runSpeak();
      };
      window.setTimeout(runSpeak, 180);
    } else {
      runSpeak();
    }
  } catch {
    // Abaikan
  }
}

function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
) {
  const R = 6371e3;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function extractLinesFromPdfBytes(bytes: Uint8Array): string[] {
  const raw = new TextDecoder("latin1").decode(bytes);
  const lines: string[] = [];

  const parenMatches = raw.match(/\(([^()\\]{1,180})\)/g) || [];
  for (const m of parenMatches) {
    const cleaned = m
      .slice(1, -1)
      .replace(/\\([()\\])/g, "$1")
      .replace(/[^\x20-\x7E]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length >= 1 && /[a-zA-Z0-9]/.test(cleaned)) {
      lines.push(cleaned);
    }
  }

  const hexMatches = raw.match(/<([0-9A-Fa-f\s]{4,240})>/g) || [];
  for (const hm of hexMatches) {
    const hex = hm.slice(1, -1).replace(/\s+/g, "");
    if (hex.length >= 4 && hex.length % 2 === 0) {
      let decoded = "";
      for (let i = 0; i < hex.length; i += 2) {
        const code = parseInt(hex.slice(i, i + 2), 16);
        if (code >= 32 && code <= 126) decoded += String.fromCharCode(code);
      }
      const cleaned = decoded.replace(/\s+/g, " ").trim();
      if (cleaned.length >= 2 && /[a-zA-Z0-9]/.test(cleaned)) {
        lines.push(cleaned);
      }
    }
  }

  return lines;
}

function detectShiftCodeFromText(text: string): ShiftCode {
  const upper = text.toUpperCase();
  const lower = text.toLowerCase();

  if (/\bOFF\b/.test(upper) || lower.includes("libur") || lower.includes("off")) {
    return "OFF";
  }
  if (
    /\bM\b/.test(upper) ||
    lower.includes("malam") ||
    text.includes("23.00") ||
    text.includes("23:00")
  ) {
    return "M";
  }
  if (
    /\bS\b/.test(upper) ||
    lower.includes("siang") ||
    text.includes("15.00") ||
    text.includes("15:00")
  ) {
    return "S";
  }
  return "P";
}

function parseScheduleLines(lines: string[]): ParsedScheduleItem[] {
  const parsed: ParsedScheduleItem[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (
      lower.includes("emp_code") ||
      (lower.includes("jadwal") && lower.length < 22) ||
      (lower.includes("nama") && lower.includes("shift") && lower.length < 34)
    ) {
      continue;
    }

    const shiftCode = detectShiftCodeFromText(line);
    const codeMatch = line.match(
      /\b([A-Z]{2,6}-SCRTY-MPI\.\d{8}\.\d{4}|[A-Z]{2,6}[-_]\d{1,6})\b/i
    );

    const dayTokens = line.match(/\b(P|S|M|OFF)\b/gi);
    const weekly: Partial<WeeklyScheduleMap> = {};
    if (dayTokens && dayTokens.length >= 7) {
      DAYS_OF_WEEK.forEach((d, idx) => {
        const tok = (dayTokens[idx] || "P").toUpperCase();
        weekly[d] =
          tok === "OFF" ? "OFF" : tok === "S" ? "S" : tok === "M" ? "M" : "P";
      });
    }

    let cols = line
      .split(/[,;|]+/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (cols.length === 1 && /\s{2,}|\s+[-–—]\s+/.test(line)) {
      cols = line
        .split(/\s{2,}|\s+[-–—]\s+/)
        .map((c) => c.trim())
        .filter(Boolean);
    }

    const empCode = codeMatch ? codeMatch[1].toUpperCase() : "";
    let fullName = "";

    if (cols.length >= 2) {
      if (!empCode && /^[A-Z0-9_.-]{2,32}$/i.test(cols[0])) {
        fullName = cols[1];
      } else {
        fullName = cols[0];
      }
    } else {
      fullName = line;
    }

    fullName = fullName
      .replace(
        /\b([A-Z]{2,6}-SCRTY-MPI\.\d{8}\.\d{4}|[A-Z]{2,6}[-_]\d{1,6})\b/gi,
        " "
      )
      .replace(/\b(OFF|P|S|M)\b/g, " ")
      .replace(/shift\s*(pagi|siang|malam|libur|off)/gi, " ")
      .replace(/\b(pagi|siang|malam|libur)\b/gi, " ")
      .replace(/\b([012]?\d[:.]\d{2})\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (fullName || empCode) {
      const code =
        empCode || `KRY-${String(parsed.length + 1).padStart(3, "0")}`;
      parsed.push({
        emp_code: code,
        full_name: fullName || code,
        shift_code: shiftCode,
        shift_label: shiftCodeToLabel(shiftCode),
        shift_time: shiftCodeToStartTime(shiftCode),
        weekly: Object.keys(weekly).length > 0 ? weekly : undefined,
      });
    }
  }

  return parsed;
}

function renderDepartureBoardPosterDataUrl(
  fileName: string,
  uploadedAtLabel: string,
  staffEmployees: Employee[],
  parsedItems: ParsedScheduleItem[]
): string {
  if (typeof document === "undefined") return "";
  const width = 920;
  const rowH = 44;
  const headerH = 142;
  const footerH = 46;
  const rowsToDraw =
    staffEmployees.length > 0
      ? staffEmployees
      : DEFAULT_EMPLOYEES.filter((e) => e.role === "STAFF");
  const height = headerH + rowsToDraw.length * rowH + footerH;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#082A63";
  ctx.fillRect(0, 0, width, 86);

  ctx.fillStyle = "#FFFFFF";
  ctx.font = "900 22px sans-serif";
  ctx.fillText("JADWAL KEBERANGKATAN MINGGUAN KARYAWAN", 22, 34);

  ctx.fillStyle = "#BAE6FD";
  ctx.font = "bold 13px sans-serif";
  ctx.fillText(
    `SECURITY DORMITORY BATANG • Sumber PDF Admin: ${fileName}`,
    22,
    58
  );

  ctx.fillStyle = "#93C5FD";
  ctx.font = "11px monospace";
  ctx.fillText(`Diunggah Admin: ${uploadedAtLabel}`, 22, 76);

  ctx.fillStyle = "#F1F5F9";
  ctx.fillRect(0, 86, width, 24);
  ctx.fillStyle = "#0F172A";
  ctx.font = "bold 11px sans-serif";
  ctx.fillText(
    "KETERANGAN SHIFT:   [ P ] Pagi: 07.00 - 15.00 WIB   |   [ S ] Siang: 15.00 - 23.00 WIB   |   [ M ] Malam: 23.00 - 07.00 WIB   |   [ OFF ] Libur",
    22,
    102
  );

  const colNameW = 290;
  const dayColW = (width - colNameW) / 7;
  const tblHeaderY = 110;
  ctx.fillStyle = "#0F172A";
  ctx.fillRect(0, tblHeaderY, width, 32);

  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 12px sans-serif";
  ctx.fillText("NAMA & ID ANGGOTA", 18, tblHeaderY + 20);

  DAYS_OF_WEEK.forEach((day, idx) => {
    const x = colNameW + idx * dayColW;
    ctx.fillText(day.toUpperCase(), x + 16, tblHeaderY + 20);
  });

  rowsToDraw.forEach((emp, rIdx) => {
    const y = headerH + rIdx * rowH;
    ctx.fillStyle = rIdx % 2 === 0 ? "#FFFFFF" : "#F8FAFC";
    ctx.fillRect(0, y, width, rowH);

    ctx.strokeStyle = "#CBD5E1";
    ctx.lineWidth = 1;
    ctx.strokeRect(0, y, width, rowH);

    ctx.fillStyle = "#0F172A";
    ctx.font = "bold 13px sans-serif";
    ctx.fillText(emp.full_name, 16, y + 19);

    ctx.fillStyle = "#475569";
    ctx.font = "10px monospace";
    ctx.fillText(emp.emp_code, 16, y + 34);

    const matchedParsed = parsedItems.find(
      (p) =>
        p.emp_code.toUpperCase() === emp.emp_code.toUpperCase() ||
        p.full_name.toLowerCase() === emp.full_name.toLowerCase()
    );
    const wk: WeeklyScheduleMap = {
      ...(emp.weekly_schedule ||
        buildDefaultWeeklySchedule(shiftTimeToCode(emp.shift_start_time))),
      ...(matchedParsed?.weekly || {}),
    };

    DAYS_OF_WEEK.forEach((day, dIdx) => {
      const code: ShiftCode = wk[day] || "P";
      const cellX = colNameW + dIdx * dayColW;
      ctx.strokeRect(cellX, y, dayColW, rowH);

      const badgeX = cellX + 12;
      const badgeY = y + 8;
      const badgeW = dayColW - 24;
      const badgeH = rowH - 16;

      if (code === "OFF") {
        ctx.fillStyle = "#FEE2E2";
      } else if (code === "P") {
        ctx.fillStyle = "#DBEAFE";
      } else if (code === "S") {
        ctx.fillStyle = "#FEF3C7";
      } else {
        ctx.fillStyle = "#E0E7FF";
      }
      ctx.fillRect(badgeX, badgeY, badgeW, badgeH);

      ctx.fillStyle =
        code === "OFF"
          ? "#B91C1C"
          : code === "P"
          ? "#1D4ED8"
          : code === "S"
          ? "#B45309"
          : "#3730A3";
      ctx.font = "900 12px sans-serif";
      const label =
        code === "OFF" ? "OFF" : `${code} (${SHIFT_PRESETS[code].start})`;
      ctx.fillText(label, badgeX + 8, badgeY + 18);
    });
  });

  const footerY = headerH + rowsToDraw.length * rowH;
  ctx.fillStyle = "#082A63";
  ctx.fillRect(0, footerY, width, footerH);
  ctx.fillStyle = "#E2E8F0";
  ctx.font = "bold 11px sans-serif";
  ctx.fillText(
    "Tampil Otomatis di Board Aplikasi Admin & Aplikasi Karyawan • Wajib Hadir Maksimal +5 Menit Toleransi",
    22,
    footerY + 27
  );

  return canvas.toDataURL("image/png");
}

function parseSavedLocation(raw: string | null): LocationItem | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    const lat = Number(p.latitude);
    const lng = Number(p.longitude);
    const rad = Math.max(10, Number(p.radius_meters) || DEFAULT_RADIUS);
    if (
      !isNaN(lat) &&
      !isNaN(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180
    ) {
      return {
        id: Number(p.id) || 1,
        name: String(p.name || "Kantor Utama"),
        latitude: lat,
        longitude: lng,
        radius_meters: rad,
      };
    }
  } catch {
    // Abaikan
  }
  return null;
}

function loadWeeklySchedulesMap(): Record<string, WeeklyScheduleMap> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(WEEKLY_SCHED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistWeeklySchedulesFromEmployees(list: Employee[]) {
  if (typeof window === "undefined") return;
  try {
    const currentMap = loadWeeklySchedulesMap();
    list.forEach((emp) => {
      const code = String(emp.emp_code || "").trim().toUpperCase();
      if (!code) return;
      const defCode = shiftTimeToCode(emp.shift_start_time);
      currentMap[code] = sanitizeWeeklySchedule(emp.weekly_schedule, defCode);
    });
    localStorage.setItem(WEEKLY_SCHED_KEY, JSON.stringify(currentMap));
  } catch {
    // Abaikan
  }
}

function getInitialBoot() {
  if (typeof window === "undefined") {
    return {
      serverMode: "ADMIN" as ServerMode,
      isDeviceLockedKaryawan: false,
      isStaffLoggedIn: false,
      isAuthenticatedPrivileged: false,
      qrCode: "ABSENSI-KANTOR-MPI-BTG",
      staffEmpId: 3,
      staffEmpCode: "AP-SCRTY-MPI.22112026.0001",
      queue: [] as TimeEntry[],
      employees: DEFAULT_EMPLOYEES,
      locations: DEFAULT_LOCATIONS,
      entries: [] as TimeEntry[],
      schedulePoster: null as UploadedSchedulePoster | null,
    };
  }

  let qrCode = "ABSENSI-KANTOR-MPI-BTG";
  let staffEmpId = 3;
  let staffEmpCode = "AP-SCRTY-MPI.22112026.0001";
  let isStaffLoggedIn = false;
  let queue: TimeEntry[] = [];
  const weeklyMap = loadWeeklySchedulesMap();
  const devReg = loadDeviceRegistry();
  let employees = ensureLockedEmployees(DEFAULT_EMPLOYEES, weeklyMap, devReg);
  let locations = DEFAULT_LOCATIONS;
  let entries: TimeEntry[] = [];
  let isDeviceLockedKaryawan = false;
  let serverMode: ServerMode = "ADMIN";
  let isAuthenticatedPrivileged = false;
  const schedulePoster = loadSchedulePoster();

  try {
    const params = new URLSearchParams(window.location.search);
    const qServer = (params.get("server") || "").toLowerCase();
    const savedAuthServer = localStorage.getItem(AUTH_SERVER_KEY);

    if (
      qServer === "karyawan" ||
      qServer === "staff" ||
      localStorage.getItem(DEVICE_LOCK_KEY) === "1"
    ) {
      localStorage.setItem(DEVICE_LOCK_KEY, "1");
      localStorage.removeItem(AUTH_SERVER_KEY);
      isDeviceLockedKaryawan = true;
      serverMode = "KARYAWAN";
      isAuthenticatedPrivileged = false;
    } else if (qServer === "manager") {
      serverMode = "MANAGER";
      isAuthenticatedPrivileged = savedAuthServer === "MANAGER";
    } else {
      serverMode = "ADMIN";
      isAuthenticatedPrivileged = savedAuthServer === "ADMIN";
    }

    const savedQr = localStorage.getItem(QR_CODE_KEY);
    if (savedQr) qrCode = savedQr;

    const savedStaff = localStorage.getItem(STAFF_EMP_KEY);
    if (savedStaff && Number(savedStaff) > 0) staffEmpId = Number(savedStaff);

    const savedStaffCode = localStorage.getItem(STAFF_EMP_CODE_KEY);
    if (savedStaffCode) staffEmpCode = savedStaffCode.toUpperCase();

    if (localStorage.getItem(STAFF_SESSION_KEY) === "1" && (savedStaff || savedStaffCode)) {
      isStaffLoggedIn = true;
    }

    const rawQ = localStorage.getItem(QUEUE_KEY);
    if (rawQ) {
      const parsedQ = JSON.parse(rawQ);
      if (Array.isArray(parsedQ)) queue = parsedQ;
    }

    const rawC = localStorage.getItem(CACHE_KEY);
    if (rawC) {
      const c = JSON.parse(rawC);
      if (Array.isArray(c.employees) && c.employees.length > 0) {
        employees = ensureLockedEmployees(c.employees, weeklyMap, devReg);
      }
      if (Array.isArray(c.locations) && c.locations.length > 0) {
        locations = c.locations.map((l: LocationItem) => ({
          id: Number(l.id) || 1,
          name: String(l.name || "Kantor Utama"),
          latitude: Number(l.latitude) || DEFAULT_LAT,
          longitude: Number(l.longitude) || DEFAULT_LNG,
          radius_meters: Math.max(10, Number(l.radius_meters) || DEFAULT_RADIUS),
        }));
      }
      if (Array.isArray(c.entries)) {
        entries = c.entries.map((item: TimeEntry) => ({
          ...item,
          entry_type: normalizeEntryType(item.entry_type),
          client_uuid:
            item.client_uuid ||
            `srv-${item.id || Math.random().toString(36).slice(2)}`,
        }));
      }
    }

    const customLoc = parseSavedLocation(localStorage.getItem(LOC_KEY));
    if (customLoc) {
      locations = [customLoc];
    }
  } catch {
    // Abaikan error storage
  }

  return {
    serverMode,
    isDeviceLockedKaryawan,
    isStaffLoggedIn,
    isAuthenticatedPrivileged,
    qrCode,
    staffEmpId,
    staffEmpCode,
    queue,
    employees,
    locations,
    entries,
    schedulePoster,
  };
}

export default function AbsensiMultiServerPage() {
  const boot = useMemo(() => getInitialBoot(), []);

  const [serverMode, setServerMode] = useState<ServerMode>(boot.serverMode);
  const [isDeviceLockedKaryawan, setIsDeviceLockedKaryawan] = useState<boolean>(
    boot.isDeviceLockedKaryawan
  );
  const [isStaffLoggedIn, setIsStaffLoggedIn] = useState<boolean>(
    boot.isStaffLoggedIn
  );
  const [staffLoginCode, setStaffLoginCode] = useState<string>("");
  const [staffLoginPin, setStaffLoginPin] = useState<string>("");
  const [isLoggingInStaff, setIsLoggingInStaff] = useState<boolean>(false);
  const [currentHpDevice, setCurrentHpDevice] = useState<DeviceSystemInfo>(() =>
    collectHpDeviceSystemInfo()
  );

  const [installPromptEvent, setInstallPromptEvent] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [installGuideOpen, setInstallGuideOpen] = useState<boolean>(false);

  const [isPrivilegedAuthed, setIsPrivilegedAuthed] = useState<boolean>(
    boot.isAuthenticatedPrivileged
  );
  const [pinEntry, setPinEntry] = useState("");

  const [employees, setEmployees] = useState<Employee[]>(boot.employees);
  const [locations, setLocations] = useState<LocationItem[]>(boot.locations);
  const [serverEntries, setServerEntries] = useState<TimeEntry[]>(boot.entries);
  const [offlineQueue, setOfflineQueue] = useState<TimeEntry[]>(boot.queue);
  const [staffEmpId, setStaffEmpId] = useState<number>(boot.staffEmpId);
  const [staffEmpCode, setStaffEmpCode] = useState<string>(boot.staffEmpCode);
  const [dbConnected, setDbConnected] = useState<boolean>(true);

  const [serverOffsetMs, setServerOffsetMs] = useState<number>(0);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [isSyncing, setIsSyncing] = useState(false);

  const [selectedAction, setSelectedAction] = useState<"CLOCK_IN" | "CLOCK_OUT">(
    "CLOCK_IN"
  );
  const [officeQrCode, setOfficeQrCode] = useState<string>(boot.qrCode);
  const [qrInput, setQrInput] = useState("");
  const [qrCameraOn, setQrCameraOn] = useState(false);
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lng: number } | null>(
    null
  );
  const [gpsStatusText, setGpsStatusText] = useState<string>(
    "Menunggu pembacaan GPS perangkat..."
  );

  const [selfieCameraOn, setSelfieCameraOn] = useState(false);
  const [capturedSelfie, setCapturedSelfie] = useState<string | null>(null);
  const [faceStatus, setFaceStatus] = useState<
    "idle" | "scanning" | "detected" | "no_face" | "fallback"
  >("idle");
  const [faceText, setFaceText] = useState(
    "Arahkan wajah ke kamera depan lalu klik Ambil Foto Selfie."
  );

  const [dismissedLateUuid, setDismissedLateUuid] = useState<string | null>(null);

  const [inspectionMode, setInspectionMode] = useState<
    "NONE" | "XLSX" | "PDF"
  >("NONE");
  const [inspectionNote, setInspectionNote] = useState("");

  const [scheduleFileName, setScheduleFileName] = useState(
    boot.schedulePoster?.fileName || "Tidak ada file yang dipilih"
  );
  const [schedulePreview, setSchedulePreview] = useState<ParsedScheduleItem[]>(
    boot.schedulePoster?.summaryRows || []
  );
  const [schedulePoster, setSchedulePoster] =
    useState<UploadedSchedulePoster | null>(boot.schedulePoster);
  const [scheduleImageZoomOpen, setScheduleImageZoomOpen] =
    useState<boolean>(false);

  const [reportFilter, setReportFilter] = useState<
    "Harian" | "Mingguan" | "Bulanan"
  >("Harian");
  const [reportEmpFilter, setReportEmpFilter] = useState<string>("ALL");
  const [selectedReportUuids, setSelectedReportUuids] = useState<string[]>([]);

  const [editingUuid, setEditingUuid] = useState<string | null>(null);
  const [editId, setEditId] = useState<number | undefined>(undefined);
  const [editType, setEditType] = useState<"CLOCK_IN" | "CLOCK_OUT">(
    "CLOCK_IN"
  );
  const [editTimeLocal, setEditTimeLocal] = useState("");
  const [editNotes, setEditNotes] = useState("");

  const [empForm, setEmpForm] = useState({
    id: 0,
    emp_code: "",
    full_name: "",
    role: "STAFF" as RoleType,
    department: "Security Dormitory Batang",
    pin_code: "1001",
    shift_start_time: "07.00",
    weekly_schedule: buildDefaultWeeklySchedule("P"),
  });
  const [latInput, setLatInput] = useState<string>(
    String(boot.locations[0]?.latitude ?? DEFAULT_LAT)
  );
  const [lngInput, setLngInput] = useState<string>(
    String(boot.locations[0]?.longitude ?? DEFAULT_LNG)
  );
  const [radiusInput, setRadiusInput] = useState<string>(
    String(boot.locations[0]?.radius_meters ?? DEFAULT_RADIUS)
  );

  const [toast, setToast] = useState<{
    type: "ok" | "warn" | "err";
    text: string;
  } | null>(null);

  const qrVideoRef = useRef<HTMLVideoElement | null>(null);
  const qrRafRef = useRef<number | null>(null);
  const selfieVideoRef = useRef<HTMLVideoElement | null>(null);
  const selfieCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const faceRafRef = useRef<number | null>(null);
  const scheduleInputRef = useRef<HTMLInputElement | null>(null);
  const empFormSectionRef = useRef<HTMLDivElement | null>(null);
  const offsetRef = useRef<number>(0);
  const syncInFlightRef = useRef<boolean>(false);

  const notify = useCallback((type: "ok" | "warn" | "err", text: string) => {
    setToast({ type, text });
    setTimeout(() => setToast(null), 4500);
  }, []);

  useEffect(() => {
    setCurrentHpDevice(collectHpDeviceSystemInfo());
  }, []);

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setInstallPromptEvent(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstall);
  }, []);

  const triggerGoogleAppDownloadInstall = async () => {
    if (installPromptEvent) {
      await installPromptEvent.prompt();
      const choice = await installPromptEvent.userChoice;
      if (choice.outcome === "accepted") {
        notify("ok", "Aplikasi Login & Absensi sedang diunduh/diinstal ke HP.");
        setInstallPromptEvent(null);
      }
      return;
    }
    setInstallGuideOpen((prev) => !prev);
  };

  useEffect(() => {
    offsetRef.current = serverOffsetMs;
  }, [serverOffsetMs]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowMs(Date.now() + offsetRef.current);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const syncedIsoNow = useMemo(() => new Date(nowMs).toISOString(), [nowMs]);

  const indonesiaClockWIB = useMemo(
    () =>
      new Intl.DateTimeFormat("id-ID", {
        timeZone: "Asia/Jakarta",
        weekday: "long",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(nowMs)) + " WIB",
    [nowMs]
  );

  const staffList = useMemo(
    () => employees.filter((e) => e.role === "STAFF"),
    [employees]
  );

  const activeUser = useMemo(() => {
    if (isDeviceLockedKaryawan || serverMode === "KARYAWAN") {
      return (
        staffList.find(
          (e) =>
            e.emp_code.toUpperCase() === staffEmpCode.toUpperCase() ||
            Number(e.id) === Number(staffEmpId)
        ) ||
        staffList[0] ||
        DEFAULT_EMPLOYEES[2]
      );
    }
    if (serverMode === "MANAGER") {
      return (
        employees.find((e) => e.role === "MANAGER") || DEFAULT_EMPLOYEES[1]
      );
    }
    return employees.find((e) => e.role === "ADMIN") || DEFAULT_EMPLOYEES[0];
  }, [isDeviceLockedKaryawan, serverMode, staffList, staffEmpCode, staffEmpId, employees]);

  const activeUserTodayShift = useMemo(
    () => getEmployeeShiftForIso(activeUser, syncedIsoNow),
    [activeUser, syncedIsoNow]
  );

  const activeUserWeeklySchedule = useMemo<WeeklyScheduleMap>(() => {
    return sanitizeWeeklySchedule(
      activeUser?.weekly_schedule,
      shiftTimeToCode(activeUser?.shift_start_time)
    );
  }, [activeUser]);

  const isKaryawanMode = isDeviceLockedKaryawan || serverMode === "KARYAWAN";
  const isManagerServer = !isKaryawanMode && serverMode === "MANAGER";
  const isAdminServer = !isKaryawanMode && serverMode === "ADMIN";

  const stopQrCam = useCallback(() => {
    if (qrRafRef.current !== null) {
      cancelAnimationFrame(qrRafRef.current);
      qrRafRef.current = null;
    }
    if (qrVideoRef.current?.srcObject) {
      (qrVideoRef.current.srcObject as MediaStream)
        .getTracks()
        .forEach((t) => t.stop());
      qrVideoRef.current.srcObject = null;
    }
    setQrCameraOn(false);
  }, []);

  const stopSelfieCam = useCallback(() => {
    if (faceRafRef.current !== null) {
      cancelAnimationFrame(faceRafRef.current);
      faceRafRef.current = null;
    }
    if (selfieVideoRef.current?.srcObject) {
      (selfieVideoRef.current.srcObject as MediaStream)
        .getTracks()
        .forEach((t) => t.stop());
      selfieVideoRef.current.srcObject = null;
    }
    setSelfieCameraOn(false);
  }, []);

  const applyServerState = useCallback(
    (data: Record<string, unknown>) => {
      if (!data?.ok) return;
      setDbConnected(Boolean(data.dbConnected));

      if (data.officeQr) {
        setOfficeQrCode(String(data.officeQr));
        localStorage.setItem(QR_CODE_KEY, String(data.officeQr));
      }

      if (
        data.schedulePoster &&
        typeof data.schedulePoster === "object" &&
        (data.schedulePoster as UploadedSchedulePoster).imageDataUrl
      ) {
        const poster = data.schedulePoster as UploadedSchedulePoster;
        setSchedulePoster(poster);
        localStorage.setItem(SCHEDULE_POSTER_KEY, JSON.stringify(poster));
      }

      const weeklyMap = loadWeeklySchedulesMap();
      if (data.weeklySchedules && typeof data.weeklySchedules === "object") {
        Object.entries(data.weeklySchedules as Record<string, unknown>).forEach(
          ([code, sched]) => {
            weeklyMap[String(code).trim().toUpperCase()] = sanitizeWeeklySchedule(
              sched,
              "P"
            );
          }
        );
      }

      const devReg = loadDeviceRegistry();
      const rawEmps = Array.isArray(data.employees)
        ? (data.employees as Employee[])
        : [];
      const rawLocs = Array.isArray(data.locations)
        ? (data.locations as LocationItem[])
        : [];
      const rawEntries = Array.isArray(data.entries)
        ? (data.entries as TimeEntry[])
        : [];

      setEmployees((prevEmps) => {
        const baseList =
          rawEmps.length > 0
            ? rawEmps.map((e) => {
                const codeUpper = String(e.emp_code || "").trim().toUpperCase();
                const prevMatch = prevEmps.find(
                  (pe) =>
                    pe.emp_code.toUpperCase() === codeUpper ||
                    Number(pe.id) === Number(e.id)
                );
                const defCode = shiftTimeToCode(
                  e.shift_start_time || prevMatch?.shift_start_time
                );
                const serverSchedule = e.weekly_schedule
                  ? sanitizeWeeklySchedule(e.weekly_schedule, defCode)
                  : weeklyMap[codeUpper]
                  ? sanitizeWeeklySchedule(weeklyMap[codeUpper], defCode)
                  : sanitizeWeeklySchedule(prevMatch?.weekly_schedule, defCode);

                weeklyMap[codeUpper] = serverSchedule;
                return {
                  ...e,
                  emp_code: codeUpper,
                  pin_code: String(
                    e.pin_code || prevMatch?.pin_code || "1001"
                  ).trim(),
                  shift_start_time:
                    e.shift_start_time ||
                    prevMatch?.shift_start_time ||
                    shiftCodeToStartTime(serverSchedule.Senin || "P"),
                  weekly_schedule: serverSchedule,
                  last_device: e.last_device || prevMatch?.last_device,
                };
              })
            : prevEmps;

        localStorage.setItem(WEEKLY_SCHED_KEY, JSON.stringify(weeklyMap));
        const nextEmps = ensureLockedEmployees(baseList, weeklyMap, devReg);

        const nextLocs: LocationItem[] =
          rawLocs.length > 0
            ? rawLocs.map((l) => ({
                id: Number(l.id) || 1,
                name: String(l.name || "Kantor Utama"),
                latitude: Number(l.latitude) || DEFAULT_LAT,
                longitude: Number(l.longitude) || DEFAULT_LNG,
                radius_meters: Math.max(
                  10,
                  Number(l.radius_meters) || DEFAULT_RADIUS
                ),
              }))
            : DEFAULT_LOCATIONS;

        setLocations(nextLocs);
        if (nextLocs[0]) {
          localStorage.setItem(LOC_KEY, JSON.stringify(nextLocs[0]));
        }
        setLatInput(String(nextLocs[0]?.latitude ?? DEFAULT_LAT));
        setLngInput(String(nextLocs[0]?.longitude ?? DEFAULT_LNG));
        setRadiusInput(String(nextLocs[0]?.radius_meters ?? DEFAULT_RADIUS));

        setServerEntries((prevEntries) => {
          const nextEntries: TimeEntry[] =
            rawEntries.length > 0
              ? rawEntries.map((item) => {
                  const prevE = prevEntries.find(
                    (pe) => pe.client_uuid === item.client_uuid
                  );
                  return {
                    ...item,
                    entry_type: normalizeEntryType(item.entry_type),
                    selfie_data: item.selfie_data || prevE?.selfie_data || null,
                    device_info: item.device_info || prevE?.device_info || "",
                    client_uuid:
                      item.client_uuid ||
                      `srv-${item.id || Math.random().toString(36).slice(2)}`,
                  };
                })
              : rawEntries;

          localStorage.setItem(
            CACHE_KEY,
            JSON.stringify({
              employees: nextEmps,
              locations: nextLocs,
              entries: nextEntries,
            })
          );
          return nextEntries;
        });

        return nextEmps;
      });
    },
    []
  );

  const syncOfflineQueue = useCallback(
    async (queue: TimeEntry[], silent = false) => {
      if (!navigator.onLine || queue.length === 0 || syncInFlightRef.current) {
        return;
      }
      syncInFlightRef.current = true;
      setIsSyncing(true);
      try {
        const res = await fetch("/api/absen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "SUBMIT_PUNCH", punches: queue }),
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data?.ok) {
          const syncedSet = new Set<string>(
            Array.isArray(data.syncedUuids)
              ? data.syncedUuids.map(String)
              : queue.map((q) => q.client_uuid)
          );
          setOfflineQueue((prev) => {
            const remaining = prev.filter((q) => !syncedSet.has(q.client_uuid));
            localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
            return remaining;
          });
          applyServerState(data);
          if (!silent) {
            notify("ok", `${data.syncedCount || queue.length} data tersinkron.`);
          }
        }
      } catch {
        // Tetap di antrean lokal
      } finally {
        syncInFlightRef.current = false;
        setIsSyncing(false);
      }
    },
    [notify, applyServerState]
  );

  const refreshServer = useCallback(
    async (silent = false) => {
      if (!navigator.onLine) {
        setNowMs(Date.now() + offsetRef.current);
        if (!silent) notify("warn", "Offline: jam WIB tersinkronisasi lokal.");
        return;
      }
      setIsSyncing(true);
      try {
        const rawQ = localStorage.getItem(QUEUE_KEY);
        const pending: TimeEntry[] = rawQ ? JSON.parse(rawQ) : [];
        if (pending.length > 0) await syncOfflineQueue(pending, true);

        const res = await fetch(`/api/absen?t=${Date.now()}`, { cache: "no-store" });
        const headerDate = res.headers.get("date");
        let nextOffset = offsetRef.current;
        if (headerDate) {
          const srvMs = new Date(headerDate).getTime();
          if (!isNaN(srvMs)) {
            nextOffset = srvMs - Date.now();
            setServerOffsetMs(nextOffset);
          }
        }
        setNowMs(Date.now() + nextOffset);

        if (res.ok) {
          const data = await res.json();
          if (data?.ok) {
            applyServerState(data);
            if (!silent) {
              notify(
                data.dbConnected ? "ok" : "warn",
                data.dbConnected
                  ? "Terhubung ke Database Neon & Data Admin Realtime Sinkron."
                  : `Peringatan DB: ${data.dbError || "DATABASE_URL belum aktif"}`
              );
            }
          }
        }
      } catch {
        setNowMs(Date.now() + offsetRef.current);
        if (!silent) {
          notify("warn", "Mode lokal/cache aktif; jam WIB tetap berjalan.");
        }
      } finally {
        setIsSyncing(false);
      }
    },
    [notify, syncOfflineQueue, applyServerState]
  );

  useEffect(() => {
    if (!isOnline) return;
    const poller = window.setInterval(() => {
      void refreshServer(true);
    }, 2500);
    return () => clearInterval(poller);
  }, [isOnline, refreshServer]);

  useEffect(() => {
    if (!isOnline || offlineQueue.length === 0) return;
    const timer = window.setInterval(() => {
      void syncOfflineQueue(offlineQueue, true);
    }, 1500);
    return () => clearInterval(timer);
  }, [isOnline, offlineQueue, syncOfflineQueue]);

  const requestCurrentGps = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setGpsStatusText("GPS browser tidak tersedia.");
      return;
    }
    setGpsStatusText("Mengambil posisi GPS...");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Number(pos.coords.latitude.toFixed(7));
        const lng = Number(pos.coords.longitude.toFixed(7));
        setGpsCoords({ lat, lng });
        setGpsStatusText(`GPS aktif: ${lat}, ${lng}`);
      },
      (err) => {
        setGpsStatusText(
          err.code === 1
            ? "Izin lokasi ditolak. Aktifkan izin GPS di browser."
            : "Sinyal GPS lemah. Coba ambil ulang GPS."
        );
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 30000 }
    );
  }, []);

  useEffect(() => {
    const flushNow = () => {
      const onlineNow = navigator.onLine;
      setIsOnline(onlineNow);
      if (onlineNow) {
        void refreshServer(true);
      }
    };

    const onOnline = () => {
      setIsOnline(true);
      void refreshServer(true);
      notify("ok", "Online — menyinkronkan data absen ke database...");
    };
    const onOffline = () => {
      setIsOnline(false);
      notify("warn", "Offline: absensi masuk antrean lokal.");
    };
    const onVisibilityOrFocus = () => {
      if (document.visibilityState === "visible") {
        flushNow();
      }
    };
    const onStorageSync = (ev: StorageEvent) => {
      if (ev.key === SCHEDULE_POSTER_KEY && ev.newValue) {
        try {
          setSchedulePoster(JSON.parse(ev.newValue));
        } catch {
          // Abaikan
        }
      }
      if (ev.key === WEEKLY_SCHED_KEY) {
        const wm = loadWeeklySchedulesMap();
        setEmployees((prev) =>
          ensureLockedEmployees(prev, wm, loadDeviceRegistry())
        );
      }
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("focus", flushNow);
    window.addEventListener("pageshow", flushNow);
    window.addEventListener("storage", onStorageSync);
    document.addEventListener("visibilitychange", onVisibilityOrFocus);

    const t = window.setTimeout(() => {
      void refreshServer(true);
      requestCurrentGps();
    }, 0);

    return () => {
      clearTimeout(t);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("focus", flushNow);
      window.removeEventListener("pageshow", flushNow);
      window.removeEventListener("storage", onStorageSync);
      document.removeEventListener("visibilitychange", onVisibilityOrFocus);
      stopQrCam();
      stopSelfieCam();
    };
  }, [refreshServer, requestCurrentGps, notify, stopQrCam, stopSelfieCam]);

  const handleStaffMemberLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const codeClean = staffLoginCode.trim().toUpperCase();
    const pinClean = staffLoginPin.trim();

    if (!codeClean || !pinClean) {
      notify("err", "Masukkan ID Karyawan dan PIN yang dibuat Admin.");
      return;
    }

    setIsLoggingInStaff(true);
    const devInfo = collectHpDeviceSystemInfo(new Date(nowMs).toISOString());
    setCurrentHpDevice(devInfo);

    let matched: Employee | undefined;

    if (navigator.onLine) {
      try {
        const res = await fetch("/api/absen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "VERIFY_LOGIN",
            payload: {
              emp_code: codeClean,
              pin_code: pinClean,
              device_detail: devInfo,
            },
          }),
          cache: "no-store",
        });
        const data = await res.json();
        if (res.ok && data?.ok && data.matchedEmployee) {
          applyServerState(data);
          matched = data.matchedEmployee as Employee;
        } else if (res.status === 401) {
          setIsLoggingInStaff(false);
          notify(
            "err",
            data?.error ||
              "ID Karyawan atau PIN salah / belum sinkron di server Admin."
          );
          return;
        }
      } catch {
        // Fallback ke daftar karyawan lokal jika jaringan terputus
      }
    }

    if (!matched) {
      matched = employees.find(
        (emp) =>
          emp.role === "STAFF" &&
          emp.emp_code.trim().toUpperCase() === codeClean &&
          String(emp.pin_code || "").trim() === pinClean
      );
    }

    setIsLoggingInStaff(false);

    if (!matched) {
      notify(
        "err",
        "ID Karyawan atau PIN salah / belum terdaftar di server Admin."
      );
      return;
    }

    const devReg = loadDeviceRegistry();
    devReg[matched.emp_code] = devInfo;
    localStorage.setItem(DEVICE_REG_KEY, JSON.stringify(devReg));

    setEmployees((prev) =>
      prev.map((emp) =>
        emp.emp_code.toUpperCase() === matched!.emp_code.toUpperCase()
          ? { ...emp, last_device: devInfo }
          : emp
      )
    );

    setStaffEmpId(Number(matched.id));
    setStaffEmpCode(matched.emp_code.toUpperCase());
    localStorage.setItem(STAFF_EMP_KEY, String(matched.id));
    localStorage.setItem(STAFF_EMP_CODE_KEY, matched.emp_code.toUpperCase());
    localStorage.setItem(STAFF_SESSION_KEY, "1");
    setIsStaffLoggedIn(true);
    setStaffLoginPin("");

    notify(
      "ok",
      `Login berhasil: ${matched.full_name} (${matched.emp_code}) • Data & jadwal sinkron dari Admin!`
    );
  };

  const handleStaffMemberLogout = () => {
    stopQrCam();
    stopSelfieCam();
    localStorage.removeItem(STAFF_SESSION_KEY);
    setIsStaffLoggedIn(false);
    setStaffLoginCode("");
    setStaffLoginPin("");
    notify("ok", "Sesi akun anggota ditutup. Masukkan ID & PIN untuk login.");
  };

  const targetLocation = useMemo(() => {
    const loc = locations[0] || DEFAULT_LOCATIONS[0];
    return {
      latitude: Number(loc.latitude),
      longitude: Number(loc.longitude),
      radius_meters: Math.max(10, Number(loc.radius_meters) || DEFAULT_RADIUS),
    };
  }, [locations]);

  const geofence = useMemo(() => {
    if (!gpsCoords) return null;
    const dist = haversineMeters(
      gpsCoords.lat,
      gpsCoords.lng,
      targetLocation.latitude,
      targetLocation.longitude
    );
    return {
      distance: dist,
      inside: dist <= targetLocation.radius_meters,
    };
  }, [gpsCoords, targetLocation]);

  const geofenceLabel = useMemo(() => {
    if (!geofence) {
      return `${gpsStatusText} • Target (${targetLocation.latitude}, ${targetLocation.longitude}) • Radius ${targetLocation.radius_meters}m`;
    }
    return `GPS: Jarak ${geofence.distance}m / ${targetLocation.radius_meters}m (${
      geofence.inside ? "Aman • Di Dalam Radius" : "Di Luar Radius Kantor"
    })`;
  }, [geofence, gpsStatusText, targetLocation]);

  const allEntries = useMemo(() => {
    const seen = new Set(serverEntries.map((e) => e.client_uuid));
    const pending = offlineQueue.filter((q) => !seen.has(q.client_uuid));
    return [...pending, ...serverEntries].sort(
      (a, b) =>
        new Date(b.punched_at).getTime() - new Date(a.punched_at).getTime()
    );
  }, [serverEntries, offlineQueue]);

  const todayStr = getJakartaDateStr(syncedIsoNow);

  const attendanceGuard = useMemo(() => {
    if (!activeUser) {
      return {
        hasClockInToday: false,
        hasClockOutToday: false,
        inCooldown: false,
        remainingText: "",
        lastEntry: null as TimeEntry | null,
      };
    }

    const mineAll = allEntries
      .filter(
        (e) =>
          Number(e.employee_id) === Number(activeUser.id) ||
          (e.emp_code &&
            e.emp_code.toUpperCase() === activeUser.emp_code.toUpperCase())
      )
      .sort(
        (a, b) =>
          new Date(b.punched_at).getTime() - new Date(a.punched_at).getTime()
      );

    const mineToday = mineAll.filter(
      (e) => getJakartaDateStr(e.punched_at) === todayStr
    );

    const hasClockInToday = mineToday.some((e) => e.entry_type === "CLOCK_IN");
    const hasClockOutToday = mineToday.some((e) => e.entry_type === "CLOCK_OUT");

    const last = mineAll[0] || null;
    if (!last) {
      return {
        hasClockInToday,
        hasClockOutToday,
        inCooldown: false,
        remainingText: "",
        lastEntry: null,
      };
    }

    const diff = nowMs - new Date(last.punched_at).getTime();
    if (diff >= 0 && diff < SIX_HOURS_MS) {
      const remMins = Math.ceil((SIX_HOURS_MS - diff) / 60000);
      const h = Math.floor(remMins / 60);
      const m = remMins % 60;
      return {
        hasClockInToday,
        hasClockOutToday,
        inCooldown: true,
        remainingText: h > 0 ? `${h} jam ${m} menit` : `${m} menit`,
        lastEntry: last,
      };
    }

    return {
      hasClockInToday,
      hasClockOutToday,
      inCooldown: false,
      remainingText: "",
      lastEntry: last,
    };
  }, [activeUser, allEntries, todayStr, nowMs]);

  const isActionLocked = (actionType: "CLOCK_IN" | "CLOCK_OUT") => {
    if (actionType === "CLOCK_IN" && attendanceGuard.hasClockInToday) {
      return true;
    }
    if (actionType === "CLOCK_OUT" && attendanceGuard.hasClockOutToday) {
      return true;
    }
    return attendanceGuard.inCooldown;
  };

  const startScannerCamera = async () => {
    try {
      stopSelfieCam();
      setQrCameraOn(true);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      if (qrVideoRef.current) {
        qrVideoRef.current.srcObject = stream;
        await qrVideoRef.current.play();
      }
      const BD = (
        window as unknown as {
          BarcodeDetector?: new (opts: {
            formats: string[];
          }) => BarcodeDetectorInstance;
        }
      ).BarcodeDetector;

      if (BD) {
        const detector = new BD({
          formats: ["qr_code", "code_128", "code_39", "ean_13"],
        });
        const step = async () => {
          if (!qrVideoRef.current || !qrVideoRef.current.srcObject) return;
          try {
            const codes = await detector.detect(qrVideoRef.current);
            const raw = (codes[0]?.rawValue || codes[0]?.raw_value || "")
              .trim()
              .toUpperCase();
            if (raw) {
              setQrInput(raw);
              stopQrCam();
              notify("ok", `Barcode/QR terbaca: ${raw}`);
              return;
            }
          } catch {
            // Lanjutkan scan
          }
          qrRafRef.current = requestAnimationFrame(step);
        };
        qrRafRef.current = requestAnimationFrame(step);
      } else {
        notify(
          "warn",
          "Kamera scanner aktif. Ketik kode manual jika tidak terbaca otomatis."
        );
      }
    } catch {
      setQrCameraOn(false);
      notify("warn", "Kamera terkendala. Masukkan kode barcode/QR manual.");
    }
  };

  const runFaceLoop = useCallback(() => {
    const FD = (
      window as unknown as {
        FaceDetector?: new (opts?: {
          fastMode?: boolean;
          maxDetectedFaces?: number;
        }) => FaceDetectorInstance;
      }
    ).FaceDetector;

    if (!FD) {
      setFaceStatus("fallback");
      setFaceText(
        "Kamera depan aktif; klik Ambil Foto Selfie untuk cap waktu & lokasi."
      );
      return;
    }

    const detector = new FD({ fastMode: true, maxDetectedFaces: 1 });
    setFaceStatus("scanning");
    setFaceText("Mendeteksi wajah di kamera depan...");

    const loop = async () => {
      if (!selfieVideoRef.current || !selfieVideoRef.current.srcObject) return;
      try {
        const faces = await detector.detect(selfieVideoRef.current);
        if (faces.length > 0) {
          setFaceStatus("detected");
          setFaceText("Wajah terdeteksi! Klik Ambil Foto Selfie.");
        } else {
          setFaceStatus("no_face");
          setFaceText("Wajah belum terlihat di kamera depan.");
        }
      } catch {
        setFaceStatus("fallback");
        setFaceText("Klik Ambil Foto Selfie untuk menyimpan foto.");
        return;
      }
      faceRafRef.current = requestAnimationFrame(loop);
    };
    faceRafRef.current = requestAnimationFrame(loop);
  }, []);

  const openSelfieCamera = async (forAction?: "CLOCK_IN" | "CLOCK_OUT") => {
    try {
      if (forAction) setSelectedAction(forAction);
      stopQrCam();
      stopSelfieCam();
      setCapturedSelfie(null);
      setSelfieCameraOn(true);

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "user" },
            width: { ideal: 480 },
            height: { ideal: 480 },
          },
          audio: false,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: false,
        });
      }

      if (selfieVideoRef.current) {
        selfieVideoRef.current.srcObject = stream;
        await selfieVideoRef.current.play();
      }
      runFaceLoop();
    } catch {
      setSelfieCameraOn(false);
      notify("err", "Izinkan kamera depan untuk selfie absen masuk/keluar.");
    }
  };

  const takeSelfiePhoto = async () => {
    if (!selfieVideoRef.current || !selfieCanvasRef.current) return;
    const FD = (
      window as unknown as {
        FaceDetector?: new (opts?: {
          fastMode?: boolean;
          maxDetectedFaces?: number;
        }) => FaceDetectorInstance;
      }
    ).FaceDetector;

    let detected = faceStatus === "detected";
    if (!detected && FD) {
      try {
        const detector = new FD({ fastMode: true, maxDetectedFaces: 1 });
        const faces = await detector.detect(selfieVideoRef.current);
        detected = faces.length > 0;
      } catch {
        detected = false;
      }
    }

    if (FD && !detected) {
      setFaceStatus("no_face");
      setFaceText("Wajah tidak terdeteksi. Arahkan wajah ke kamera depan.");
      notify("err", "Wajah belum terdeteksi!");
      return;
    }

    const c = selfieCanvasRef.current;
    const width = 480;
    const height = 480;
    c.width = width;
    c.height = height;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    ctx.save();
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(selfieVideoRef.current, 0, 0, width, height);
    ctx.restore();

    const stampMs = Date.now() + offsetRef.current;
    const wibStamp = formatFullTimestampWIB(stampMs);
    const latVal = gpsCoords?.lat ?? targetLocation.latitude;
    const lngVal = gpsCoords?.lng ?? targetLocation.longitude;
    const distVal = geofence ? `${geofence.distance}m` : "GPS";
    const radiusStatus = geofence
      ? geofence.inside
        ? "IN RADIUS"
        : "OUT RADIUS"
      : "CAM VERIFIED";
    const faceTag = FD
      ? detected
        ? "FACE VERIFIED"
        : "CAM LIVE"
      : "CAM LIVE";
    const actionLabel = selectedAction === "CLOCK_OUT" ? "KELUAR" : "MASUK";
    const userLabel = activeUser
      ? `${activeUser.full_name} • ${activeUser.emp_code}`
      : "KARYAWAN";

    ctx.fillStyle = "rgba(11, 18, 32, 0.82)";
    ctx.fillRect(10, 10, width - 20, 26);
    ctx.fillStyle = "#34D399";
    ctx.font = "bold 11px monospace";
    ctx.fillText(
      `TIMEMARK VERIFIED • ${actionLabel} • ${faceTag} • ${radiusStatus}`,
      16,
      27
    );

    const boxH = 104;
    const boxY = height - boxH - 10;
    ctx.fillStyle = "rgba(11, 18, 32, 0.86)";
    ctx.fillRect(10, boxY, width - 20, boxH);

    ctx.strokeStyle = "#38BDF8";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(10, boxY, width - 20, boxH);

    ctx.fillStyle = "#FFFFFF";
    ctx.font = "bold 13px sans-serif";
    ctx.fillText(wibStamp, 18, boxY + 20);

    ctx.fillStyle = "#BAE6FD";
    ctx.font = "bold 11px sans-serif";
    ctx.fillText(userLabel, 18, boxY + 38);

    ctx.fillStyle = "#86EFAC";
    ctx.font = "11px monospace";
    ctx.fillText(
      `GPS: ${latVal}, ${lngVal} (${distVal}/${targetLocation.radius_meters}m)`,
      18,
      boxY + 56
    );

    ctx.fillStyle = "#E2E8F0";
    ctx.font = "10px sans-serif";
    const devText = currentHpDevice.summary.slice(0, 62);
    ctx.fillText(`Device: ${devText}`, 18, boxY + 74);

    ctx.fillStyle = "#94A3B8";
    ctx.font = "10px monospace";
    ctx.fillText(`QR: ${officeQrCode} • LatLng Verified`, 18, boxY + 91);

    const dataUrl = c.toDataURL("image/jpeg", 0.78);
    setCapturedSelfie(dataUrl);
    setFaceStatus(FD ? "detected" : "fallback");
    setFaceText(
      `Foto TimeMark (${actionLabel}) siap dengan cap waktu, lokasi & verifikasi.`
    );
    stopSelfieCam();
    notify(
      "ok",
      `Foto selfie ${actionLabel} dengan watermark waktu & lokasi berhasil diambil.`
    );
  };

  const submitAttendance = async (
    typeOverride?: "CLOCK_IN" | "CLOCK_OUT",
    manualCodeOverride?: string
  ) => {
    unlockAudioContext();
    if (!activeUser) return;
    const syncedNow = Date.now() + offsetRef.current;
    setNowMs(syncedNow);

    const entryType = typeOverride || selectedAction;

    if (entryType === "CLOCK_IN" && attendanceGuard.hasClockInToday) {
      notify(
        "err",
        "Sudah absen MASUK 1 kali hari ini (tidak bisa absen ganda). Hubungi Admin jika perlu reset/hapus data."
      );
      return;
    }

    if (entryType === "CLOCK_OUT" && attendanceGuard.hasClockOutToday) {
      notify(
        "err",
        "Sudah absen KELUAR 1 kali hari ini (tidak bisa absen ganda). Hubungi Admin jika perlu reset/hapus data."
      );
      return;
    }

    if (attendanceGuard.inCooldown) {
      notify(
        "err",
        `Harus menunggu 6 jam setelah absen terakhir (sisa ${attendanceGuard.remainingText}).`
      );
      return;
    }

    const enteredCode = (manualCodeOverride ?? qrInput).trim().toUpperCase();
    const effectiveQr =
      enteredCode ||
      officeQrCode.trim().toUpperCase() ||
      "ABSENSI-KANTOR-MPI-BTG";

    if (enteredCode && enteredCode !== officeQrCode.trim().toUpperCase()) {
      notify(
        "err",
        `Kode Barcode/QR salah! Gunakan QR resmi (${officeQrCode}).`
      );
      return;
    }

    if (isKaryawanMode) {
      if (!gpsCoords) {
        notify("err", "Aktifkan GPS lokasi untuk memverifikasi titik absen.");
        return;
      }
      if (geofence && !geofence.inside) {
        notify(
          "err",
          `Di luar radius kantor (${geofence.distance}m > ${targetLocation.radius_meters}m).`
        );
        return;
      }
      if (!capturedSelfie) {
        notify(
          "err",
          `Wajib ambil foto selfie kamera depan sebelum absen ${
            entryType === "CLOCK_IN" ? "MASUK" : "KELUAR"
          }.`
        );
        void openSelfieCamera(entryType);
        return;
      }
    }

    const punchedAtIso = new Date(syncedNow).toISOString();
    const devInfo = collectHpDeviceSystemInfo(punchedAtIso);
    setCurrentHpDevice(devInfo);

    const devReg = loadDeviceRegistry();
    devReg[activeUser.emp_code] = devInfo;
    localStorage.setItem(DEVICE_REG_KEY, JSON.stringify(devReg));
    setEmployees((prev) =>
      prev.map((emp) =>
        emp.emp_code.toUpperCase() === activeUser.emp_code.toUpperCase()
          ? { ...emp, last_device: devInfo }
          : emp
      )
    );

    const shiftToday = getEmployeeShiftForIso(activeUser, punchedAtIso);
    const lateInfo =
      entryType === "CLOCK_IN"
        ? calcLateDetail(punchedAtIso, shiftToday.startTime)
        : { rawDiffMinutes: 0, lateMinutes: 0, isLate: false, statusNote: "" };

    const uuid =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${syncedNow}-${Math.random().toString(36).slice(2)}`;

    const latVal = gpsCoords?.lat ?? targetLocation.latitude;
    const lngVal = gpsCoords?.lng ?? targetLocation.longitude;
    const locStampNote = `TimeMark GPS ${latVal}, ${lngVal} (${
      geofence?.distance ?? 0
    }m)`;

    const newPunch: TimeEntry = {
      client_uuid: uuid,
      employee_id: Number(activeUser.id),
      entry_type: entryType,
      punched_at: punchedAtIso,
      is_offline_sync: !navigator.onLine,
      qr_code: effectiveQr,
      mode: capturedSelfie
        ? "TIMEMARK + BARCODE + WAJAH"
        : enteredCode
        ? "BARCODE + GPS"
        : "MANUAL KLIK",
      notes: lateInfo.isLate
        ? `${lateInfo.statusNote} • ${locStampNote}`
        : locStampNote,
      latitude: latVal,
      longitude: lngVal,
      distance_meters: geofence?.distance ?? 0,
      is_within_geofence: geofence ? geofence.inside : true,
      selfie_data: capturedSelfie,
      face_detected: Boolean(capturedSelfie && faceStatus !== "no_face"),
      full_name: activeUser.full_name,
      emp_code: activeUser.emp_code,
      device_info: devInfo.summary,
    };

    const nextQueue = [newPunch, ...offlineQueue];
    setOfflineQueue(nextQueue);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(nextQueue));
    setQrInput("");
    setCapturedSelfie(null);
    setFaceStatus("idle");
    setFaceText("Arahkan wajah ke kamera depan lalu klik Ambil Foto Selfie.");

    if (entryType === "CLOCK_IN") {
      if (isAdminServer) {
        speakIndonesian("Terimakasih Sudah Hadir, Selamat Bertempur");
      } else if (lateInfo.isLate) {
        speakIndonesian(
          `Perhatian, ${activeUser.full_name} terlambat ${lateInfo.lateMinutes} menit dari jam masuk ${shiftToday.startTime}.`
        );
      } else {
        speakIndonesian(
          `Absen masuk ${activeUser.full_name} tercatat tepat waktu.`
        );
      }
    } else {
      speakIndonesian("Terimakasih, semoga selamat sampai rumah");
    }

    if (navigator.onLine) {
      await syncOfflineQueue(nextQueue, true);
      await refreshServer(true);
    }
    notify(
      "ok",
      entryType === "CLOCK_IN"
        ? lateInfo.isLate
          ? `Absen MASUK tercatat (TERLAMBAT ${lateInfo.lateMinutes} menit)!`
          : "Terimakasih Sudah Hadir, Selamat Bertempur!"
        : "Terimakasih, semoga selamat sampai rumah!"
    );
  };

  const lockDeviceToKaryawan = () => {
    stopQrCam();
    stopSelfieCam();
    localStorage.setItem(DEVICE_LOCK_KEY, "1");
    localStorage.removeItem(AUTH_SERVER_KEY);
    localStorage.removeItem(STAFF_SESSION_KEY);
    setIsDeviceLockedKaryawan(true);
    setIsStaffLoggedIn(false);
    setIsPrivilegedAuthed(false);
    setServerMode("KARYAWAN");
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("server", "karyawan");
      window.history.replaceState({}, "", url.toString());
    }
    notify(
      "ok",
      "Perangkat dikunci ke Server Karyawan. Silakan login per anggota dengan ID & PIN."
    );
  };

  const verifyPrivilegedLogin = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const expectedPin =
      activeUser?.pin_code || (isManagerServer ? "2026" : "0000");
    if (pinEntry.trim() === expectedPin) {
      localStorage.setItem(AUTH_SERVER_KEY, serverMode);
      setIsPrivilegedAuthed(true);
      setPinEntry("");
      notify("ok", `Login ${serverMode} berhasil.`);
    } else {
      notify("err", `PIN ${serverMode} salah.`);
    }
  };

  const latestLateAlertToday = useMemo(() => {
    const todayIns = allEntries
      .filter(
        (e) =>
          e.entry_type === "CLOCK_IN" &&
          getJakartaDateStr(e.punched_at) === todayStr
      )
      .sort(
        (a, b) =>
          new Date(b.punched_at).getTime() - new Date(a.punched_at).getTime()
      );

    for (const item of todayIns) {
      if (item.client_uuid === dismissedLateUuid) continue;
      const emp = employees.find(
        (e) =>
          Number(e.id) === Number(item.employee_id) ||
          (item.emp_code &&
            e.emp_code.toUpperCase() === item.emp_code.toUpperCase())
      );
      const shift = getEmployeeShiftForIso(emp, item.punched_at);
      const detail = calcLateDetail(item.punched_at, shift.startTime);
      if (detail.isLate) {
        return {
          uuid: item.client_uuid,
          employeeName: item.full_name || emp?.full_name || "Karyawan",
          empCode: item.emp_code || emp?.emp_code || "",
          lateMinutes: detail.lateMinutes,
          shiftLabel: `${shift.code} (${shift.rangeLabel})`,
          punchedTime: formatTimeWIB(item.punched_at),
          statusNote: detail.statusNote,
        };
      }
    }
    return null;
  }, [allEntries, todayStr, employees, dismissedLateUuid]);

  const summaryToday = useMemo(() => {
    const todayEntries = allEntries.filter(
      (e) => getJakartaDateStr(e.punched_at) === todayStr
    );
    const inIds = new Set<string>();
    const outIds = new Set<string>();
    let lateCount = 0;

    for (const item of todayEntries) {
      const emp = employees.find(
        (e) =>
          Number(e.id) === Number(item.employee_id) ||
          (item.emp_code &&
            e.emp_code.toUpperCase() === item.emp_code.toUpperCase())
      );
      const key = emp?.emp_code || String(item.employee_id);
      if (item.entry_type === "CLOCK_IN") {
        inIds.add(key);
        const shift = getEmployeeShiftForIso(emp, item.punched_at);
        if (calcLateDetail(item.punched_at, shift.startTime).isLate) {
          lateCount++;
        }
      } else if (item.entry_type === "CLOCK_OUT") {
        outIds.add(key);
      }
    }

    return {
      masuk: inIds.size,
      terlambat: lateCount,
      keluar: outIds.size,
    };
  }, [allEntries, todayStr, employees]);

  const filteredEntries = useMemo(() => {
    const limitDays =
      reportFilter === "Harian" ? 1 : reportFilter === "Mingguan" ? 7 : 31;
    const minMs = nowMs - limitDays * 86400000;
    return allEntries.filter((e) => {
      const matchPeriod =
        reportFilter === "Harian"
          ? getJakartaDateStr(e.punched_at) === todayStr
          : new Date(e.punched_at).getTime() >= minMs;
      if (!matchPeriod) return false;
      if (reportEmpFilter !== "ALL") {
        return String(e.employee_id) === reportEmpFilter;
      }
      return true;
    });
  }, [allEntries, reportFilter, reportEmpFilter, todayStr, nowMs]);

  const toggleReportUuid = (uuid: string) => {
    setSelectedReportUuids((prev) =>
      prev.includes(uuid) ? prev.filter((u) => u !== uuid) : [...prev, uuid]
    );
  };

  const toggleSelectAllReport = () => {
    if (
      filteredEntries.length > 0 &&
      selectedReportUuids.length === filteredEntries.length
    ) {
      setSelectedReportUuids([]);
    } else {
      setSelectedReportUuids(filteredEntries.map((e) => e.client_uuid));
    }
  };

  const handleScheduleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!isAdminServer) {
      notify(
        "err",
        "Akses ditolak: hanya Admin yang dapat memasukkan file jadwal PDF di dasbor Admin."
      );
      return;
    }
    const file = e.target.files?.[0];
    if (!file) return;

    const isPdf =
      file.type === "application/pdf" ||
      file.name.toLowerCase().endsWith(".pdf");

    if (!isPdf) {
      notify(
        "err",
        "Gunakan file PDF jadwal resmi yang dibuat Admin (.pdf)."
      );
      if (scheduleInputRef.current) scheduleInputRef.current.value = "";
      return;
    }

    setScheduleFileName(file.name);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = parseScheduleLines(extractLinesFromPdfBytes(bytes));
      setSchedulePreview(parsed);

      const weeklyMap = loadWeeklySchedulesMap();
      const updatedEmployees = employees.map((emp) => {
        const match = parsed.find(
          (r) =>
            r.emp_code.toLowerCase() === emp.emp_code.toLowerCase() ||
            r.full_name.toLowerCase() === emp.full_name.toLowerCase()
        );
        if (!match) return emp;
        const nextWeekly: WeeklyScheduleMap = sanitizeWeeklySchedule(
          {
            ...(emp.weekly_schedule ||
              buildDefaultWeeklySchedule(match.shift_code)),
            ...(match.weekly || {}),
          },
          match.shift_code
        );
        if (!match.weekly) {
          DAYS_OF_WEEK.forEach((d) => {
            if (d !== "Minggu") nextWeekly[d] = match.shift_code;
          });
        }
        weeklyMap[emp.emp_code.toUpperCase()] = nextWeekly;
        return {
          ...emp,
          full_name: match.full_name || emp.full_name,
          shift_start_time: match.shift_time,
          weekly_schedule: nextWeekly,
        };
      });

      localStorage.setItem(WEEKLY_SCHED_KEY, JSON.stringify(weeklyMap));
      setEmployees(updatedEmployees);

      const staffOnly = updatedEmployees.filter((emp) => emp.role === "STAFF");
      const uploadedAtLabel = formatFullTimestampWIB(nowMs);
      const posterDataUrl = renderDepartureBoardPosterDataUrl(
        file.name,
        uploadedAtLabel,
        staffOnly,
        parsed
      );

      const posterObj: UploadedSchedulePoster = {
        fileName: file.name,
        uploadedAt: uploadedAtLabel,
        uploadedBy: activeUser?.full_name || "Admin Operasional",
        imageDataUrl: posterDataUrl,
        summaryRows: parsed,
      };

      setSchedulePoster(posterObj);
      localStorage.setItem(SCHEDULE_POSTER_KEY, JSON.stringify(posterObj));

      if (navigator.onLine) {
        try {
          const res = await fetch("/api/absen", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "SAVE_SCHEDULE_POSTER",
              payload: {
                poster: posterObj,
                weeklySchedules: weeklyMap,
                employees: updatedEmployees,
              },
            }),
            cache: "no-store",
          });
          if (res.ok) {
            const data = await res.json();
            applyServerState(data);
          }
        } catch {
          // Tetap tersimpan lokal
        }
      }

      notify(
        "ok",
        `File PDF ${file.name} berhasil diunggah Admin & tersinkron ke database Neon!`
      );
    } catch {
      notify("err", `Gagal memproses file PDF ${file.name}.`);
    } finally {
      if (scheduleInputRef.current) scheduleInputRef.current.value = "";
    }
  };

  const getEntriesForExport = () => {
    if (selectedReportUuids.length > 0) {
      const picked = filteredEntries.filter((e) =>
        selectedReportUuids.includes(e.client_uuid)
      );
      if (picked.length > 0) return picked;
    }
    return filteredEntries;
  };

  const buildGroupedTimesheetRows = (entriesToUse: TimeEntry[]) => {
    const groups = new Map<
      string,
      {
        dateStr: string;
        dayName: string;
        empId: number;
        empName: string;
        empCode: string;
        deviceSummary: string;
        shiftInfo: { code: ShiftCode; startTime: string; rangeLabel: string };
        inEntry?: TimeEntry;
        outEntry?: TimeEntry;
      }
    >();

    const chronological = [...entriesToUse].sort(
      (a, b) =>
        new Date(a.punched_at).getTime() - new Date(b.punched_at).getTime()
    );

    for (const item of chronological) {
      const dateStr = getJakartaDateStr(item.punched_at);
      const emp = employees.find(
        (e) =>
          Number(e.id) === Number(item.employee_id) ||
          (item.emp_code &&
            e.emp_code.toUpperCase() === item.emp_code.toUpperCase())
      );
      const key = `${emp?.emp_code || item.employee_id}__${dateStr}`;
      const dayName = new Date(item.punched_at).toLocaleDateString("id-ID", {
        timeZone: "Asia/Jakarta",
        weekday: "long",
      });
      const devStr =
        item.device_info || emp?.last_device?.summary || "Perangkat HP";

      const existing = groups.get(key) || {
        dateStr,
        dayName,
        empId: Number(item.employee_id),
        empName: item.full_name || emp?.full_name || "Karyawan",
        empCode: item.emp_code || emp?.emp_code || "-",
        deviceSummary: devStr,
        shiftInfo: getEmployeeShiftForIso(emp, item.punched_at),
      };

      if (item.device_info) {
        existing.deviceSummary = item.device_info;
      }

      if (item.entry_type === "CLOCK_IN") {
        if (!existing.inEntry) existing.inEntry = item;
      } else {
        existing.outEntry = item;
      }
      groups.set(key, existing);
    }

    return Array.from(groups.values()).sort((a, b) =>
      b.dateStr.localeCompare(a.dateStr)
    );
  };

  const buildTimesheetHeaderMeta = (
    groupedRows: ReturnType<typeof buildGroupedTimesheetRows>
  ) => {
    const uniqueEmpCodes = Array.from(new Set(groupedRows.map((g) => g.empCode)));
    const singleEmp =
      reportEmpFilter !== "ALL"
        ? employees.find((e) => String(e.id) === reportEmpFilter)
        : uniqueEmpCodes.length === 1
        ? employees.find((e) => e.emp_code === uniqueEmpCodes[0])
        : undefined;

    const memberName = singleEmp
      ? singleEmp.full_name
      : groupedRows.length > 0 && uniqueEmpCodes.length === 1
      ? groupedRows[0].empName
      : "SEMUA ANGGOTA / TERPILIH";

    const memberCode = singleEmp
      ? singleEmp.emp_code
      : groupedRows.length > 0 && uniqueEmpCodes.length === 1
      ? groupedRows[0].empCode
      : "ALL-SECURITY-BTG";

    return {
      memberName,
      memberCode,
      monthLabel: `01 November 2026 - 30 November 2026 (${reportFilter})`,
    };
  };

  const runInspection = (format: "XLSX" | "PDF") => {
    if (isKaryawanMode) return;
    const entriesToUse = getEntriesForExport();
    const grouped = buildGroupedTimesheetRows(entriesToUse);
    const faceInCount = grouped.filter((g) => Boolean(g.inEntry?.selfie_data)).length;
    const faceOutCount = grouped.filter((g) => Boolean(g.outEntry?.selfie_data)).length;
    const totalLateMins = grouped.reduce((acc, g) => {
      if (!g.inEntry) return acc;
      return (
        acc + calcLateDetail(g.inEntry.punched_at, g.shiftInfo.startTime).lateMinutes
      );
    }, 0);

    setInspectionMode(format);
    setInspectionNote(
      `Inspeksi ${format}: ${grouped.length} rekap harian (${entriesToUse.length} scan) • Foto Wajah Masuk: ${faceInCount}, Foto Wajah Keluar: ${faceOutCount} • Total telat (>5 mnt): ${totalLateMins} menit • Logo MURINDA & Timesheet Absensi Security Dormitory Batang siap.`
    );
    notify(
      "ok",
      `Inspeksi ${format} selesai: ${grouped.length} baris rekap diperiksa.`
    );
  };

  const exportReport = (format: "XLSX" | "CSV" | "PDF") => {
    if (isKaryawanMode) return;
    const entriesToUse = getEntriesForExport();
    const groupedRows = buildGroupedTimesheetRows(entriesToUse);
    const meta = buildTimesheetHeaderMeta(groupedRows);

    const headers = [
      "TANGGAL",
      "HARI",
      "ANGGOTA",
      "DEVICE HP",
      "SHIFT",
      "JAM MASUK",
      "FOTO WAJAH MASUK",
      "TERAKHIR KELUAR",
      "FOTO WAJAH KELUAR",
      "JAM PENGGAJIAN",
      "JAM REG",
      "TELAT",
      "KETERANGAN",
      "MODE",
    ];

    if (format === "CSV") {
      const csvRows = groupedRows.map((g) => {
        const lateInfo = g.inEntry
          ? calcLateDetail(g.inEntry.punched_at, g.shiftInfo.startTime)
          : { lateMinutes: 0, isLate: false, statusNote: "-" };
        return [
          g.dateStr,
          g.dayName,
          `${g.empName} (${g.empCode})`,
          g.deviceSummary,
          g.shiftInfo.code === "OFF"
            ? "OFF (LIBUR)"
            : `${g.shiftInfo.code} (${g.shiftInfo.rangeLabel})`,
          g.inEntry ? formatTimeWIB(g.inEntry.punched_at) : "-",
          g.inEntry?.selfie_data ? "TIMEMARK + WAJAH" : "-",
          g.outEntry ? formatTimeWIB(g.outEntry.punched_at) : "-",
          g.outEntry?.selfie_data ? "TIMEMARK + WAJAH" : "-",
          "0j 00m",
          "0j 00m",
          lateInfo.isLate ? `${lateInfo.lateMinutes}m` : "0m",
          g.inEntry
            ? lateInfo.statusNote
            : g.shiftInfo.code === "OFF"
            ? "LIBUR (OFF)"
            : "HADIR",
          g.inEntry?.mode || g.outEntry?.mode || "TIMEMARK + BARCODE + WAJAH",
        ];
      });

      const csv = [
        ["MURINDA", "Timesheet Absensi Security Dormitory Batang"],
        ["Month", meta.monthLabel],
        ["Anggota", meta.memberName],
        ["Kode", meta.memberCode],
        headers,
        ...csvRows,
      ]
        .map((r) =>
          r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")
        )
        .join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Timesheet_Security_Dormitory_Batang_${meta.memberName.replace(/\s+/g, "_")}_${todayStr}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }

    const murindaLogoSvg = `<svg width="168" height="36" viewBox="0 0 260 54" xmlns="http://www.w3.org/2000/svg"><text x="0" y="38" font-family="Arial Black, Impact, sans-serif" font-weight="900" font-size="34" fill="#0B3B8C" letter-spacing="1.2">MURINDA</text><path d="M182 32 L242 10 L214 34 L252 29 L190 46 Z" fill="#DC2626"/><path d="M174 36 L232 16 L208 36 Z" fill="#082A63"/></svg>`;

    const bodyRowsHtml = groupedRows
      .map((g) => {
        const lateInfo = g.inEntry
          ? calcLateDetail(g.inEntry.punched_at, g.shiftInfo.startTime)
          : { lateMinutes: 0, isLate: false, statusNote: "-" };
        const inImgHtml = g.inEntry?.selfie_data
          ? `<img src="${g.inEntry.selfie_data}" width="54" height="54" style="width:54px;height:54px;object-fit:cover;border-radius:4px;border:1px solid #082A63" />`
          : `<span style="color:#64748b">-</span>`;
        const outImgHtml = g.outEntry?.selfie_data
          ? `<img src="${g.outEntry.selfie_data}" width="54" height="54" style="width:54px;height:54px;object-fit:cover;border-radius:4px;border:1px solid #082A63" />`
          : `<span style="color:#64748b">-</span>`;
        const shiftHtml =
          g.shiftInfo.code === "OFF"
            ? `<span style="color:#DC2626;font-weight:900">OFF</span>`
            : `<b>${g.shiftInfo.code}</b> (${g.shiftInfo.rangeLabel})`;
        const telatHtml = lateInfo.isLate
          ? `<span style="color:#DC2626;font-weight:900">${lateInfo.lateMinutes}m</span>`
          : `0m`;
        const ketText = g.inEntry
          ? lateInfo.statusNote
          : g.shiftInfo.code === "OFF"
          ? "LIBUR (OFF)"
          : "HADIR";

        return `<tr>
          <td>${g.dateStr}</td>
          <td>${g.dayName}</td>
          <td><b>${g.empName}</b><br/><span style="font-size:10px;color:#475569">${g.empCode}</span></td>
          <td style="font-size:10px">${g.deviceSummary}</td>
          <td>${shiftHtml}</td>
          <td>${g.inEntry ? formatTimeWIB(g.inEntry.punched_at) : "-"}</td>
          <td style="text-align:center">${inImgHtml}</td>
          <td>${g.outEntry ? formatTimeWIB(g.outEntry.punched_at) : "-"}</td>
          <td style="text-align:center">${outImgHtml}</td>
          <td>0j 00m</td>
          <td>0j 00m</td>
          <td>${telatHtml}</td>
          <td>${ketText}</td>
          <td>${g.inEntry?.mode || g.outEntry?.mode || "TIMEMARK + BARCODE + WAJAH"}</td>
        </tr>`;
      })
      .join("");

    const sheetHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Timesheet Absensi Security Dormitory Batang</title><style>body{font-family:Arial,sans-serif;color:#082A63;padding:18px}.top{display:flex;align-items:center;gap:18px;border-bottom:3px solid #0B3B8C;padding-bottom:10px;margin-bottom:12px}.title{font-size:20px;font-weight:900;color:#082A63;margin:0}.meta{margin-bottom:14px;font-size:12px;line-height:1.7;color:#082A63}.meta td{border:none;padding:2px 10px 2px 0}.grid{width:100%;border-collapse:collapse;font-size:11px}.grid th{background:#082A63;color:#ffffff;padding:7px 8px;border:1px solid #0B3B8C;text-align:left}.grid td{padding:6px 8px;border:1px solid #94a3b8;color:#0f172a;vertical-align:middle}</style></head><body><div class="top"><div>${murindaLogoSvg}</div><h1 class="title">Timesheet Absensi Security Dormitory Batang</h1></div><table class="meta"><tr><td><b>Month</b></td><td>${meta.monthLabel}</td></tr><tr><td><b>Anggota</b></td><td>${meta.memberName}</td></tr><tr><td><b>Kode</b></td><td>${meta.memberCode}</td></tr></table><table class="grid"><thead><tr>${headers
      .map((h) => `<th>${h}</th>`)
      .join("")}</tr></thead><tbody>${bodyRowsHtml}</tbody></table></body></html>`;

    if (format === "PDF") {
      const printWin = window.open("", "_blank", "width=1050,height=720");
      if (printWin) {
        printWin.document.write(sheetHtml);
        printWin.document.close();
        printWin.focus();
        printWin.print();
      } else {
        window.print();
      }
      return;
    }

    const blob = new Blob([sheetHtml], { type: "application/vnd.ms-excel" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `MURINDA_Timesheet_${meta.memberName.replace(/\s+/g, "_")}_${todayStr}.xls`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const startEditEntry = (item: TimeEntry) => {
    if (isKaryawanMode) return;
    setEditingUuid(item.client_uuid);
    setEditId(item.id);
    setEditType(item.entry_type);
    setEditTimeLocal(formatDateTimeLocalWIB(item.punched_at));
    setEditNotes(item.notes || "");
  };

  const commitEditEntry = async () => {
    if (isKaryawanMode || !editingUuid) return;
    const d = editTimeLocal
      ? new Date(`${editTimeLocal}:00+07:00`)
      : new Date(nowMs);
    const nextIso = isNaN(d.getTime())
      ? new Date(nowMs).toISOString()
      : d.toISOString();

    setServerEntries((prev) =>
      prev.map((x) =>
        x.client_uuid === editingUuid
          ? { ...x, entry_type: editType, punched_at: nextIso, notes: editNotes }
          : x
      )
    );
    setOfflineQueue((prev) => {
      const next = prev.map((x) =>
        x.client_uuid === editingUuid
          ? { ...x, entry_type: editType, punched_at: nextIso, notes: editNotes }
          : x
      );
      localStorage.setItem(QUEUE_KEY, JSON.stringify(next));
      return next;
    });

    if (navigator.onLine) {
      try {
        const res = await fetch("/api/absen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "UPDATE_ENTRY",
            payload: {
              id: editId,
              client_uuid: editingUuid,
              entry_type: editType,
              punched_at: nextIso,
              notes: editNotes,
            },
          }),
          cache: "no-store",
        });
        if (res.ok) {
          const data = await res.json();
          applyServerState(data);
        }
      } catch {
        // Pertahankan lokal
      }
    }
    setEditingUuid(null);
    notify("ok", "Waktu & data absen diperbarui.");
  };

  const removeEntry = async (item: TimeEntry) => {
    if (isKaryawanMode) return;
    const nextServer = serverEntries.filter(
      (x) =>
        x.client_uuid !== item.client_uuid && (!item.id || x.id !== item.id)
    );
    const nextQueue = offlineQueue.filter(
      (x) => x.client_uuid !== item.client_uuid
    );

    setServerEntries(nextServer);
    setOfflineQueue(nextQueue);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(nextQueue));

    try {
      const rawCache = localStorage.getItem(CACHE_KEY);
      if (rawCache) {
        const parsedCache = JSON.parse(rawCache);
        localStorage.setItem(
          CACHE_KEY,
          JSON.stringify({
            ...parsedCache,
            entries: nextServer,
          })
        );
      }
    } catch {
      // Abaikan error cache
    }

    if (navigator.onLine) {
      try {
        const res = await fetch("/api/absen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "DELETE_ENTRY",
            payload: { id: item.id, client_uuid: item.client_uuid },
          }),
          cache: "no-store",
        });
        if (res.ok) {
          const data = await res.json();
          applyServerState(data);
        }
      } catch {
        // Abaikan error
      }
    }
    notify(
      "ok",
      "Data absen dihapus — status absen anggota tersebut terbuka kembali."
    );
  };

  const beginEditEmployeeCard = (emp: Employee) => {
    const wk = sanitizeWeeklySchedule(
      emp.weekly_schedule,
      shiftTimeToCode(emp.shift_start_time)
    );
    setEmpForm({
      id: emp.id,
      emp_code: emp.emp_code,
      full_name: emp.full_name,
      role: emp.role,
      department: emp.department,
      pin_code: emp.pin_code,
      shift_start_time: normalizeShiftTime(emp.shift_start_time),
      weekly_schedule: wk,
    });
    if (empFormSectionRef.current) {
      empFormSectionRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
    notify(
      "ok",
      `Mode edit aktif untuk ${emp.full_name} (PIN saat ini: ${emp.pin_code}). Ubah PIN/Jadwal lalu klik Simpan Edit Karyawan.`
    );
  };

  const saveEmployee = async () => {
    if (
      isKaryawanMode ||
      !empForm.emp_code.trim() ||
      !empForm.full_name.trim()
    ) {
      notify("err", "Isi ID dan Nama Lengkap karyawan.");
      return;
    }
    const cleanCode = empForm.emp_code.trim().toUpperCase();
    const cleanedWeekly = sanitizeWeeklySchedule(
      empForm.weekly_schedule,
      shiftTimeToCode(empForm.shift_start_time)
    );
    const mondayCode = cleanedWeekly.Senin || "P";
    const resolvedStartTime =
      empForm.shift_start_time || shiftCodeToStartTime(mondayCode);

    const weeklyMap = loadWeeklySchedulesMap();
    weeklyMap[cleanCode] = cleanedWeekly;
    localStorage.setItem(WEEKLY_SCHED_KEY, JSON.stringify(weeklyMap));

    const payload = {
      id: empForm.id || undefined,
      emp_code: cleanCode,
      full_name: empForm.full_name.trim(),
      role: empForm.role,
      department: empForm.department.trim() || "Security Dormitory Batang",
      pin_code: empForm.pin_code.trim() || "1234",
      shift_start_time: normalizeShiftTime(resolvedStartTime),
      weekly_schedule: cleanedWeekly,
    };

    const matchedExisting = employees.some(
      (e) =>
        (empForm.id && Number(e.id) === Number(empForm.id)) ||
        e.emp_code.toUpperCase() === cleanCode
    );

    const nextEmployeesList = ensureLockedEmployees(
      matchedExisting
        ? employees.map((e) =>
            (empForm.id && Number(e.id) === Number(empForm.id)) ||
            e.emp_code.toUpperCase() === cleanCode
              ? { ...e, ...payload, id: e.id, weekly_schedule: cleanedWeekly }
              : e
          )
        : [
            ...employees,
            {
              ...payload,
              id: Date.now(),
              weekly_schedule: cleanedWeekly,
            },
          ],
      weeklyMap,
      loadDeviceRegistry()
    );

    setEmployees(nextEmployeesList);
    persistWeeklySchedulesFromEmployees(nextEmployeesList);

    if (navigator.onLine) {
      try {
        const res = await fetch("/api/absen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "SAVE_EMPLOYEE",
            payload,
            weeklySchedules: weeklyMap,
          }),
          cache: "no-store",
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.ok) {
            applyServerState(data);
            setEmpForm({
              id: 0,
              emp_code: "",
              full_name: "",
              role: "STAFF",
              department: "Security Dormitory Batang",
              pin_code: "1001",
              shift_start_time: "07.00",
              weekly_schedule: buildDefaultWeeklySchedule("P"),
            });
            notify(
              "ok",
              `Tersimpan ke Neon: ${payload.full_name} (PIN: ${payload.pin_code}) langsung sinkron ke HP Karyawan!`
            );
            return;
          }
        }
      } catch {
        // Fallback lokal
      }
    }

    setEmpForm({
      id: 0,
      emp_code: "",
      full_name: "",
      role: "STAFF",
      department: "Security Dormitory Batang",
      pin_code: "1001",
      shift_start_time: "07.00",
      weekly_schedule: buildDefaultWeeklySchedule("P"),
    });
    notify("warn", "Tersimpan lokal (cek koneksi internet untuk sinkron ke Neon).");
  };

  const deleteEmployee = async (emp: Employee) => {
    if (isKaryawanMode) return;
    if (
      LOCKED_STAFF_CODES.includes(
        emp.emp_code.toUpperCase() as (typeof LOCKED_STAFF_CODES)[number]
      )
    ) {
      notify(
        "warn",
        `Kode ${emp.emp_code} dikunci sebagai data anggota inti; gunakan Edit untuk mengubah nama/PIN.`
      );
      return;
    }
    if (navigator.onLine) {
      try {
        const res = await fetch("/api/absen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "DELETE_EMPLOYEE",
            payload: { id: emp.id },
          }),
          cache: "no-store",
        });
        if (res.ok) {
          const data = await res.json();
          applyServerState(data);
        }
      } catch {
        // Abaikan error
      }
    }
    setEmployees((prev) => prev.filter((e) => e.id !== emp.id));
    notify("ok", "Anggota karyawan dihapus.");
  };

  const fillFromCurrentGps = () => {
    if (!("geolocation" in navigator)) {
      notify("err", "GPS tidak tersedia di perangkat ini.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Number(pos.coords.latitude.toFixed(7));
        const lng = Number(pos.coords.longitude.toFixed(7));
        setLatInput(String(lat));
        setLngInput(String(lng));
        setGpsCoords({ lat, lng });
        notify("ok", `Koordinat terisi dari GPS: ${lat}, ${lng}`);
      },
      () => {
        notify("err", "Gagal membaca GPS saat ini.");
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 30000 }
    );
  };

  const saveCustomLocation = async () => {
    if (isKaryawanMode) return;
    const parsedLat = Number(String(latInput).replace(",", "."));
    const parsedLng = Number(String(lngInput).replace(",", "."));
    const parsedRadius = Math.max(10, Number(radiusInput) || DEFAULT_RADIUS);

    if (
      isNaN(parsedLat) ||
      isNaN(parsedLng) ||
      parsedLat < -90 ||
      parsedLat > 90 ||
      parsedLng < -180 ||
      parsedLng > 180
    ) {
      notify(
        "err",
        "Masukkan Latitude (-90 s/d 90) dan Longitude (-180 s/d 180) yang valid."
      );
      return;
    }

    const locPayload: LocationItem = {
      id: locations[0]?.id || 1,
      name: locations[0]?.name || "Kantor Utama",
      latitude: parsedLat,
      longitude: parsedLng,
      radius_meters: parsedRadius,
    };

    setLocations([locPayload]);
    setLatInput(String(parsedLat));
    setLngInput(String(parsedLng));
    setRadiusInput(String(parsedRadius));
    localStorage.setItem(LOC_KEY, JSON.stringify(locPayload));

    if (navigator.onLine) {
      try {
        const res = await fetch("/api/absen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "SAVE_LOCATION",
            payload: locPayload,
          }),
          cache: "no-store",
        });
        if (res.ok) {
          const data = await res.json();
          applyServerState(data);
        }
      } catch {
        // Tetap tersimpan lokal
      }
    }
    notify(
      "ok",
      `Titik koordinat diperbarui & sinkron ke semua HP: ${parsedLat}, ${parsedLng} (Radius ${parsedRadius}m)`
    );
  };

  const saveOfficeQrToServer = async (nextQr: string) => {
    const clean = nextQr.trim().toUpperCase();
    setOfficeQrCode(clean);
    localStorage.setItem(QR_CODE_KEY, clean);
    if (navigator.onLine && clean) {
      try {
        await fetch("/api/absen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "SAVE_QR",
            payload: { qrCode: clean },
          }),
          cache: "no-store",
        });
      } catch {
        // Abaikan
      }
    }
  };

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(
    officeQrCode
  )}`;

  const myRecentEntries = useMemo(() => {
    if (!activeUser) return [];
    return allEntries
      .filter(
        (e) =>
          Number(e.employee_id) === Number(activeUser.id) ||
          (e.emp_code &&
            e.emp_code.toUpperCase() === activeUser.emp_code.toUpperCase())
      )
      .slice(0, 5);
  }, [allEntries, activeUser]);

  if (!isKaryawanMode && !isPrivilegedAuthed) {
    return (
      <div className="min-h-screen bg-[#ECEFF4] flex items-center justify-center p-4">
        <form
          onSubmit={verifyPrivilegedLogin}
          className="max-w-sm w-full bg-white rounded-2xl p-5 shadow space-y-3.5 border border-slate-200"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={APP_LOGO_SRC}
                alt="Logo Absensi"
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                }}
                className="w-8 h-8 rounded-lg object-contain border border-slate-200 bg-slate-50"
              />
              <span className="text-xs font-extrabold uppercase text-slate-900">
                {isManagerServer ? "Server Manager" : "Server Administrator"}
              </span>
            </div>
            <span
              className={`px-2 py-0.5 rounded text-[9px] font-extrabold ${
                isManagerServer
                  ? "bg-amber-100 text-amber-800"
                  : "bg-indigo-100 text-indigo-800"
              }`}
            >
              {serverMode}
            </span>
          </div>

          <div className="text-[11px] font-mono text-emerald-700 bg-emerald-50 px-2.5 py-1.5 rounded-lg">
            {indonesiaClockWIB}
          </div>

          {toast && (
            <div className="px-3 py-2 rounded-lg bg-rose-600 text-white text-xs font-bold">
              {toast.text}
            </div>
          )}

          <p className="text-xs text-slate-500">
            Masukkan PIN {serverMode} ({activeUser?.full_name}) untuk akses penuh
            dasbor.
          </p>

          <input
            type="password"
            inputMode="numeric"
            placeholder={
              isManagerServer
                ? "PIN Manager (default: 2026)"
                : "PIN Admin (default: 0000)"
            }
            value={pinEntry}
            onChange={(e) => setPinEntry(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-center tracking-widest"
          />

          <button
            type="submit"
            className="w-full py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-extrabold"
          >
            Buka Server {serverMode}
          </button>

          <div className="grid grid-cols-2 gap-1.5 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={() => {
                setServerMode(isManagerServer ? "ADMIN" : "MANAGER");
                setPinEntry("");
              }}
              className="py-1.5 rounded-lg bg-slate-100 text-slate-700 text-[11px] font-bold"
            >
              {isManagerServer ? "Ke Server Admin" : "Ke Server Manager"}
            </button>
            <button
              type="button"
              onClick={lockDeviceToKaryawan}
              className="py-1.5 rounded-lg bg-sky-100 text-sky-800 text-[11px] font-bold"
            >
              Kunci HP Karyawan
            </button>
          </div>
        </form>
      </div>
    );
  }

  if (isKaryawanMode && !isStaffLoggedIn) {
    return (
      <div className="min-h-screen bg-[#ECEFF4] flex items-center justify-center p-4">
        <form
          onSubmit={(e) => void handleStaffMemberLogin(e)}
          className="max-w-sm w-full bg-white rounded-2xl p-5 shadow space-y-3 border border-slate-200"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={APP_LOGO_SRC}
                alt="Logo Absensi"
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                }}
                className="w-8 h-8 rounded-lg object-contain border border-slate-200 bg-slate-50"
              />
              <span className="text-xs font-extrabold uppercase text-slate-900">
                Login Anggota Karyawan
              </span>
            </div>
            <span className="px-2 py-0.5 rounded bg-sky-100 text-sky-800 text-[9px] font-extrabold">
              SERVER KARYAWAN
            </span>
          </div>

          <div className="text-[11px] font-mono text-emerald-700 bg-emerald-50 px-2.5 py-1.5 rounded-lg">
            {indonesiaClockWIB}
          </div>

          {toast && (
            <div
              className={`px-3 py-2 rounded-lg text-white text-xs font-bold ${
                toast.type === "ok"
                  ? "bg-emerald-600"
                  : toast.type === "warn"
                  ? "bg-amber-600"
                  : "bg-rose-600"
              }`}
            >
              {toast.text}
            </div>
          )}

          <p className="text-xs text-slate-500">
            Masukkan <b>ID Karyawan</b> dan <b>PIN</b> yang dibuat Admin di
            server utama agar akun &amp; HP rapi dan tidak bentrok.
          </p>

          <input
            type="text"
            placeholder="ID Karyawan (cth: LJ-SCRTY-MPI.22112026.0004)"
            value={staffLoginCode}
            onChange={(e) => setStaffLoginCode(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold uppercase"
          />

          <input
            type="password"
            inputMode="numeric"
            placeholder="PIN Anggota buatan Admin"
            value={staffLoginPin}
            onChange={(e) => setStaffLoginPin(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-center tracking-widest"
          />

          <div className="p-2 rounded-lg bg-slate-50 border border-slate-200 text-[10px] text-slate-600 space-y-0.5">
            <div className="font-bold text-slate-800">
              Sistem Perangkat HP Terbaca:
            </div>
            <div>{currentHpDevice.summary}</div>
            <div>
              Layar: {currentHpDevice.screen_size} • {currentHpDevice.timezone}
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoggingInStaff}
            className="w-full py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-xs font-extrabold"
          >
            {isLoggingInStaff
              ? "Menyinkronkan ke Server Admin..."
              : "Masuk Ke Akun Anggota"}
          </button>

          <button
            type="button"
            onClick={() => void triggerGoogleAppDownloadInstall()}
            className="w-full py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold"
          >
            {installPromptEvent
              ? "Download & Instal Aplikasi (Google)"
              : "Instal Aplikasi di Google / HP"}
          </button>

          {installGuideOpen && (
            <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-[10px] text-emerald-950 space-y-1">
              <div className="font-extrabold">
                Cara Menginstal Aplikasi di HP via Google:
              </div>
              <div>
                1. Buka halaman ini di browser <b>Google Chrome</b>.
              </div>
              <div>
                2. Ketuk menu <b>⋮ (titik tiga)</b> di pojok kanan atas lalu
                pilih <b>Instal aplikasi</b> atau{" "}
                <b>Tambahkan ke layar utama</b>.
              </div>
              <div>
                3. Ikon aplikasi akan muncul di layar HP dan login memakai ID &amp;
                PIN yang dibuat Admin.
              </div>
            </div>
          )}
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#ECEFF4] text-slate-900 p-2.5 sm:p-4">
      <div className="max-w-md mx-auto space-y-3.5">
        {toast && (
          <div
            className={`px-4 py-2.5 rounded-xl text-white text-xs font-bold shadow ${
              toast.type === "ok"
                ? "bg-emerald-600"
                : toast.type === "warn"
                ? "bg-amber-600"
                : "bg-rose-600"
            }`}
          >
            {toast.text}
          </div>
        )}

        {latestLateAlertToday && (
          <div className="p-3.5 rounded-2xl bg-rose-600 text-white shadow-md border-2 border-rose-200 space-y-1">
            <div className="text-[10px] font-extrabold uppercase tracking-wider text-rose-100">
              Notifikasi Keterlambatan (&gt; 5 Menit) • Shift{" "}
              {latestLateAlertToday.shiftLabel}
            </div>
            <div className="text-base sm:text-lg font-black leading-tight">
              {latestLateAlertToday.employeeName} — Terlambat{" "}
              {latestLateAlertToday.lateMinutes} Menit (Scan{" "}
              {latestLateAlertToday.punchedTime} WIB)
            </div>
            <div className="text-[11px] text-rose-100">
              {latestLateAlertToday.statusNote}
            </div>
            <button
              type="button"
              onClick={() => setDismissedLateUuid(latestLateAlertToday.uuid)}
              className="text-[10px] font-bold underline text-rose-100 pt-0.5"
            >
              Tutup Pemberitahuan
            </button>
          </div>
        )}

        <header className="bg-[#0B1220] text-white rounded-2xl p-3.5 shadow space-y-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={APP_LOGO_SRC}
                alt="Logo Absensi"
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                }}
                className="w-9 h-9 rounded-xl object-contain bg-white/10 p-1 shrink-0"
              />
              <div>
                <h1 className="text-sm font-extrabold tracking-wide uppercase">
                  APLIKASI ABSENSI QR &amp; GPS
                </h1>
                <p className="text-[11px] text-slate-300 mt-0.5">
                  {activeUser?.full_name} ({activeUser?.emp_code}) •{" "}
                  {isKaryawanMode ? "KARYAWAN" : serverMode}
                </p>
              </div>
            </div>
            <span
              className={`px-2 py-0.5 rounded text-[9px] font-extrabold uppercase shrink-0 ${
                isAdminServer
                  ? "bg-indigo-500 text-white"
                  : isManagerServer
                  ? "bg-amber-500 text-slate-950"
                  : "bg-sky-600 text-white"
              }`}
            >
              {isAdminServer
                ? "SERVER ADMIN • FULL"
                : isManagerServer
                ? "SERVER MANAGER • FULL"
                : "SERVER KARYAWAN • TERBATAS"}
            </span>
          </div>

          <div className="text-[11px] font-mono text-emerald-300 bg-white/5 px-2.5 py-1.5 rounded-lg">
            {indonesiaClockWIB}
          </div>

          {isKaryawanMode && (
            <div className="text-[10px] text-sky-200 bg-white/5 px-2.5 py-1 rounded-lg truncate">
              Device HP: {currentHpDevice.summary}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`px-2.5 py-1 rounded-md text-white text-[10px] font-extrabold uppercase ${
                dbConnected ? "bg-emerald-600" : "bg-amber-600"
              }`}
            >
              {isOnline
                ? dbConnected
                  ? "DB NEON AKTIF"
                  : "MODE LOKAL"
                : "OFFLINE"}{" "}
              • ANTREAN: {offlineQueue.length}
            </span>
            <button
              type="button"
              onClick={() => {
                void refreshServer(false);
                requestCurrentGps();
              }}
              disabled={isSyncing}
              className="px-2.5 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-[10px] font-bold"
            >
              {isSyncing ? "Sinkron..." : "Refresh Server"}
            </button>

            {isKaryawanMode && (
              <button
                type="button"
                onClick={handleStaffMemberLogout}
                className="px-2.5 py-1 rounded-md bg-rose-600 text-white text-[10px] font-bold"
              >
                Keluar Akun
              </button>
            )}

            {!isKaryawanMode && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    const nextMode: ServerMode = isAdminServer
                      ? "MANAGER"
                      : "ADMIN";
                    localStorage.removeItem(AUTH_SERVER_KEY);
                    setIsPrivilegedAuthed(false);
                    setPinEntry("");
                    setServerMode(nextMode);
                  }}
                  className="px-2.5 py-1 rounded-md bg-amber-500 text-slate-950 text-[10px] font-extrabold"
                >
                  {isAdminServer ? "Server Manager" : "Server Admin"}
                </button>
                <button
                  type="button"
                  onClick={lockDeviceToKaryawan}
                  className="px-2.5 py-1 rounded-md bg-sky-600 text-white text-[10px] font-bold"
                >
                  Mode HP Karyawan
                </button>
                <button
                  type="button"
                  onClick={() => {
                    localStorage.removeItem(AUTH_SERVER_KEY);
                    setIsPrivilegedAuthed(false);
                    setPinEntry("");
                  }}
                  className="px-2.5 py-1 rounded-md bg-rose-600 text-white text-[10px] font-bold"
                >
                  Keluar
                </button>
              </>
            )}
          </div>
        </header>

        <section className="bg-white rounded-2xl p-3.5 border-t-4 border-t-indigo-600 border border-slate-200/80 shadow-sm space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-xs font-extrabold text-slate-800">
                Jadwal Mingguan &amp; Keberangkatan Karyawan
              </h2>
              <p className="text-[10px] text-slate-500">
                {isKaryawanMode
                  ? `Jadwal Mingguan: ${activeUser?.full_name} (${activeUser?.emp_code})`
                  : "Sinkron Realtime ke Board Admin & Board Setiap Anggota"}
              </p>
            </div>
            <span className="px-2 py-0.5 rounded bg-indigo-100 text-indigo-800 text-[9px] font-extrabold uppercase shrink-0">
              {schedulePoster ? "PDF ADMIN AKTIF" : "REALTIME NEON"}
            </span>
          </div>

          <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5">
            <div className="flex items-center justify-between text-[10px]">
              <span className="font-extrabold text-slate-800">
                {activeUser?.full_name} ({activeUser?.emp_code})
              </span>
              <span className="text-slate-500 font-semibold">
                P: 07.00 • S: 15.00 • M: 23.00 • OFF: Libur
              </span>
            </div>
            <div className="grid grid-cols-7 gap-1 text-center">
              {DAYS_OF_WEEK.map((day) => {
                const code = activeUserWeeklySchedule[day] || "P";
                const isTodayCol = getJakartaDayKey(syncedIsoNow) === day;
                return (
                  <div
                    key={day}
                    className={`rounded-lg p-1 border ${
                      isTodayCol
                        ? "border-blue-600 ring-1 ring-blue-300 bg-white"
                        : "border-slate-200 bg-white"
                    }`}
                  >
                    <div className="text-[9px] font-bold text-slate-500">
                      {day.slice(0, 3)}
                    </div>
                    <div
                      className={`mt-0.5 rounded py-0.5 text-[10px] font-black ${
                        code === "OFF"
                          ? "bg-rose-100 text-rose-700"
                          : code === "P"
                          ? "bg-blue-100 text-blue-800"
                          : code === "S"
                          ? "bg-amber-100 text-amber-800"
                          : "bg-indigo-100 text-indigo-800"
                      }`}
                    >
                      {code}
                    </div>
                    <div className="text-[8px] font-mono text-slate-500 mt-0.5">
                      {code === "OFF" ? "LIBUR" : SHIFT_PRESETS[code].start}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {!isKaryawanMode && (
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-left border-collapse text-[10px]">
                <thead>
                  <tr className="bg-[#082A63] text-white">
                    <th className="p-1.5">Anggota</th>
                    {DAYS_OF_WEEK.map((d) => (
                      <th key={d} className="p-1.5 text-center">
                        {d.slice(0, 3)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {staffList.map((emp) => {
                    const wk = sanitizeWeeklySchedule(
                      emp.weekly_schedule,
                      shiftTimeToCode(emp.shift_start_time)
                    );
                    return (
                      <tr key={emp.id} className="border-t border-slate-100">
                        <td className="p-1.5 font-bold whitespace-nowrap">
                          {emp.full_name}
                        </td>
                        {DAYS_OF_WEEK.map((d) => {
                          const c = wk[d] || "P";
                          return (
                            <td key={d} className="p-1 text-center">
                              <span
                                className={`inline-block px-1.5 py-0.5 rounded font-extrabold text-[9px] ${
                                  c === "OFF"
                                    ? "bg-rose-100 text-rose-700"
                                    : c === "P"
                                    ? "bg-blue-100 text-blue-800"
                                    : c === "S"
                                    ? "bg-amber-100 text-amber-800"
                                    : "bg-indigo-100 text-indigo-800"
                                }`}
                              >
                                {c}
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {schedulePoster?.imageDataUrl && (
            <div className="p-2.5 rounded-xl bg-blue-50/70 border border-blue-200 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[10px] font-extrabold text-[#082A63]">
                  Gambar Jadwal Keberangkatan Resmi ({schedulePoster.fileName})
                </div>
                <button
                  type="button"
                  onClick={() => setScheduleImageZoomOpen((prev) => !prev)}
                  className="text-[10px] font-bold text-blue-700 underline shrink-0"
                >
                  {scheduleImageZoomOpen ? "Perkecil" : "Perbesar Gambar"}
                </button>
              </div>
              <div className="rounded-lg overflow-hidden border border-slate-300 bg-white">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={schedulePoster.imageDataUrl}
                  alt="Gambar Jadwal Keberangkatan Karyawan"
                  onClick={() => setScheduleImageZoomOpen((prev) => !prev)}
                  className={`w-full object-contain cursor-pointer transition-all ${
                    scheduleImageZoomOpen ? "max-h-[560px]" : "max-h-52"
                  }`}
                />
              </div>
              <div className="flex items-center justify-between text-[9px] text-slate-600">
                <span>Diunggah Admin: {schedulePoster.uploadedAt}</span>
                <a
                  href={schedulePoster.imageDataUrl}
                  download={`Jadwal_Keberangkatan_${todayStr}.png`}
                  className="font-bold text-emerald-700 underline"
                >
                  Simpan Gambar
                </a>
              </div>
            </div>
          )}
        </section>

        {!isKaryawanMode && (
          <section className="bg-white rounded-2xl p-3.5 border-t-4 border-t-blue-600 border border-slate-200/80 shadow-sm space-y-2.5">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-extrabold text-slate-800">
                Monitoring Kehadiran Hari Ini ({todayStr})
              </h2>
              <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[9px] font-extrabold uppercase">
                LIVE SERVER
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="p-2.5 rounded-xl bg-blue-50/80 border border-blue-100">
                <div className="text-base font-extrabold text-blue-700">
                  {summaryToday.masuk}
                </div>
                <div className="text-[10px] text-slate-500 font-medium">
                  Absen Masuk
                </div>
              </div>
              <div className="p-2.5 rounded-xl bg-amber-50/80 border border-amber-100">
                <div className="text-base font-extrabold text-amber-600">
                  {summaryToday.terlambat}
                </div>
                <div className="text-[10px] text-slate-500 font-medium">
                  Terlambat
                </div>
              </div>
              <div className="p-2.5 rounded-xl bg-emerald-50/80 border border-emerald-100">
                <div className="text-base font-extrabold text-emerald-700">
                  {summaryToday.keluar}
                </div>
                <div className="text-[10px] text-slate-500 font-medium">
                  Absen Keluar
                </div>
              </div>
            </div>
          </section>
        )}

        <section className="bg-white rounded-2xl p-3.5 border-t-4 border-t-blue-500 border border-slate-200/80 shadow-sm space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-extrabold text-slate-800">
              1. Scan Barcode/QR &amp; GPS Realtime
            </h2>
            <button
              type="button"
              onClick={requestCurrentGps}
              className="px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-[10px] font-bold"
            >
              Ambil GPS
            </button>
          </div>

          <div className="text-[11px] text-slate-600">
            Jadwal Hari Ini ({getJakartaDayKey(syncedIsoNow)}):{" "}
            {activeUserTodayShift.code === "OFF" ? (
              <span className="font-extrabold text-rose-600">OFF (Libur)</span>
            ) : (
              <span className="font-bold text-slate-800">
                Shift {activeUserTodayShift.code} ({activeUserTodayShift.rangeLabel})
              </span>
            )}{" "}
            • Toleransi telat 5 menit
          </div>
          <div className="text-[11px] font-bold text-emerald-700">
            {geofenceLabel}
          </div>
          <div className="text-[10px] text-slate-500">
            Titik Kantor Aktif: Lat {targetLocation.latitude}, Lng{" "}
            {targetLocation.longitude} • Radius {targetLocation.radius_meters}m
          </div>

          {(attendanceGuard.hasClockInToday ||
            attendanceGuard.hasClockOutToday ||
            attendanceGuard.inCooldown) && (
            <div className="p-2 rounded-xl bg-amber-50 border border-amber-300 text-[11px] font-bold text-amber-900">
              Status Hari Ini ({activeUser?.full_name}):{" "}
              {attendanceGuard.hasClockInToday ? "MASUK (1/1)" : "MASUK (0/1)"} •{" "}
              {attendanceGuard.hasClockOutToday
                ? "KELUAR (1/1)"
                : "KELUAR (0/1)"}
              {attendanceGuard.inCooldown
                ? ` • Jeda 6 jam: sisa ${attendanceGuard.remainingText}`
                : ""}
              .{" "}
              {attendanceGuard.hasClockInToday &&
              attendanceGuard.hasClockOutToday
                ? "Absen masuk & keluar hari ini sudah lengkap (tidak bisa ganda, kecuali dihapus Admin)."
                : ""}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={isActionLocked("CLOCK_IN")}
              onClick={() => {
                unlockAudioContext();
                setSelectedAction("CLOCK_IN");
                void submitAttendance("CLOCK_IN");
              }}
              className={`py-2 rounded-lg text-xs font-extrabold border disabled:opacity-45 ${
                selectedAction === "CLOCK_IN" && !isActionLocked("CLOCK_IN")
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-slate-700 border-slate-300"
              }`}
            >
              MASUK
            </button>
            <button
              type="button"
              disabled={isActionLocked("CLOCK_OUT")}
              onClick={() => {
                unlockAudioContext();
                setSelectedAction("CLOCK_OUT");
                void submitAttendance("CLOCK_OUT");
              }}
              className={`py-2 rounded-lg text-xs font-extrabold border disabled:opacity-45 ${
                selectedAction === "CLOCK_OUT" && !isActionLocked("CLOCK_OUT")
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-slate-700 border-slate-300"
              }`}
            >
              KELUAR
            </button>
          </div>

          <button
            type="button"
            onClick={() =>
              qrCameraOn ? stopQrCam() : void startScannerCamera()
            }
            className="w-full py-2.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold"
          >
            {qrCameraOn
              ? "Tutup Scanner Barcode/QR"
              : "Buka Scanner Barcode / QR"}
          </button>

          {qrCameraOn && (
            <div className="w-44 h-44 mx-auto rounded-xl overflow-hidden bg-black border-2 border-emerald-600">
              <video
                ref={qrVideoRef}
                playsInline
                muted
                className="w-full h-full object-cover"
              />
            </div>
          )}

          <div className="flex gap-1.5">
            <input
              type="text"
              placeholder="Input Kode Barcode/QR manual jika kamera terkendala"
              value={qrInput}
              onChange={(e) => setQrInput(e.target.value)}
              className="flex-1 rounded-lg border border-slate-300 px-2.5 py-2 text-xs"
            />
            <button
              type="button"
              disabled={isActionLocked(selectedAction)}
              onClick={() => void submitAttendance(selectedAction, qrInput)}
              className="px-3.5 py-2 rounded-lg bg-slate-900 disabled:opacity-45 text-white text-xs font-bold"
            >
              Kirim
            </button>
          </div>

          <div className="pt-2 border-t border-slate-100 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-extrabold text-slate-700">
                Selfie Kamera Depan + TimeMark (Masuk &amp; Keluar)
              </span>
              {capturedSelfie && (
                <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                  Siap ({selectedAction === "CLOCK_OUT" ? "KELUAR" : "MASUK"})
                </span>
              )}
            </div>
            <p
              className={`text-[10px] font-semibold ${
                faceStatus === "detected"
                  ? "text-emerald-700"
                  : faceStatus === "no_face"
                  ? "text-rose-600"
                  : "text-slate-500"
              }`}
            >
              {faceText}
            </p>

            {selfieCameraOn && (
              <div className="space-y-1.5">
                <div className="w-44 h-44 mx-auto rounded-xl overflow-hidden bg-black border-2 border-blue-600">
                  <video
                    ref={selfieVideoRef}
                    playsInline
                    muted
                    className="w-full h-full object-cover scale-x-[-1]"
                  />
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => void takeSelfiePhoto()}
                    className="py-2 rounded-lg bg-blue-600 text-white text-xs font-bold"
                  >
                    Ambil Foto Selfie
                  </button>
                  <button
                    type="button"
                    onClick={stopSelfieCam}
                    className="py-2 rounded-lg bg-slate-200 text-slate-800 text-xs font-bold"
                  >
                    Batal
                  </button>
                </div>
              </div>
            )}

            {!selfieCameraOn && (
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => void openSelfieCamera("CLOCK_IN")}
                  className="py-2 rounded-lg bg-slate-800 hover:bg-slate-900 text-white text-[11px] font-bold"
                >
                  Kamera Depan (Masuk)
                </button>
                <button
                  type="button"
                  onClick={() => void openSelfieCamera("CLOCK_OUT")}
                  className="py-2 rounded-lg bg-indigo-700 hover:bg-indigo-800 text-white text-[11px] font-bold"
                >
                  Kamera Depan (Keluar)
                </button>
              </div>
            )}

            {capturedSelfie && !selfieCameraOn && (
              <div className="flex items-center gap-2.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={capturedSelfie}
                  alt="Selfie Wajah TimeMark"
                  className="w-16 h-16 rounded-lg object-cover border border-emerald-500"
                />
                <span className="text-[11px] text-emerald-800 font-semibold">
                  Foto TimeMark (waktu, GPS &amp; verifikasi) tersimpan. Klik{" "}
                  {selectedAction === "CLOCK_OUT" ? "KELUAR" : "MASUK"}.
                </span>
              </div>
            )}
            <canvas ref={selfieCanvasRef} className="hidden" />
          </div>

          {isKaryawanMode && (
            <div className="pt-2 border-t border-slate-100 space-y-1">
              <div className="text-[10px] font-bold text-slate-500 uppercase">
                Riwayat Absen Saya (WIB)
              </div>
              {myRecentEntries.length === 0 ? (
                <div className="text-[11px] text-slate-400">
                  Belum ada catatan absen.
                </div>
              ) : (
                myRecentEntries.map((row, idx) => (
                  <div
                    key={`${row.client_uuid}-${idx}`}
                    className="flex items-center justify-between text-[11px] bg-slate-50 px-2.5 py-1.5 rounded-lg"
                  >
                    <span className="font-bold">
                      {row.entry_type === "CLOCK_IN" ? "MASUK" : "KELUAR"}
                    </span>
                    <span className="text-slate-600">
                      {formatTimeWIB(row.punched_at)} WIB
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </section>

        {!isKaryawanMode && (
          <>
            <section className="bg-white rounded-2xl p-3.5 border border-slate-200/80 shadow-sm space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-xs font-extrabold text-slate-800">
                  2. Input Jadwal Mingguan Karyawan (File .PDF Khusus Admin)
                </h2>
                <span className="px-2 py-0.5 rounded bg-indigo-100 text-indigo-800 text-[9px] font-extrabold">
                  KHUSUS ADMIN
                </span>
              </div>
              {isAdminServer ? (
                <>
                  <p className="text-[10px] text-slate-500">
                    Unggah file <b>.PDF</b> jadwal yang dibuat Admin. Setelah
                    diunggah, <b>Gambar Jadwal Keberangkatan Karyawan</b>{" "}
                    otomatis muncul di board dasbor Admin maupun setiap dasbor
                    Karyawan.
                  </p>
                  <div className="flex items-center gap-2 rounded-lg border border-slate-200 p-1.5 bg-slate-50">
                    <button
                      type="button"
                      onClick={() => scheduleInputRef.current?.click()}
                      className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-bold shrink-0"
                    >
                      Pilih File PDF
                    </button>
                    <span className="text-[11px] text-slate-500 truncate">
                      {scheduleFileName}
                    </span>
                    <input
                      ref={scheduleInputRef}
                      type="file"
                      accept=".pdf,application/pdf"
                      onChange={(e) => void handleScheduleFile(e)}
                      className="hidden"
                    />
                  </div>
                </>
              ) : (
                <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-900 font-semibold">
                  Hanya Admin yang dapat memasukkan file jadwal PDF melalui
                  dasbor Admin.
                </div>
              )}
              {schedulePreview.length > 0 && (
                <div className="space-y-1 pt-1">
                  {schedulePreview.map((r, idx) => (
                    <div
                      key={`${r.emp_code}-${idx}`}
                      className="text-[10px] bg-emerald-50 text-emerald-900 px-2.5 py-1 rounded flex justify-between font-semibold"
                    >
                      <span>
                        {r.full_name} ({r.emp_code})
                      </span>
                      <span
                        className={
                          r.shift_code === "OFF"
                            ? "text-rose-600 font-extrabold"
                            : ""
                        }
                      >
                        {r.shift_label}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="bg-white rounded-2xl p-3.5 border border-slate-200/80 shadow-sm space-y-2.5">
              <div className="flex items-center justify-between gap-1.5">
                <h2 className="text-xs font-extrabold text-slate-800">
                  3. Laporan &amp; Data Absensi:
                </h2>
                <div className="flex items-center gap-1">
                  <select
                    value={reportEmpFilter}
                    onChange={(e) => {
                      setReportEmpFilter(e.target.value);
                      setSelectedReportUuids([]);
                    }}
                    className="rounded-lg border border-slate-300 px-1.5 py-1 text-[10px] font-semibold bg-white max-w-[115px]"
                  >
                    <option value="ALL">Semua Anggota</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={String(emp.id)}>
                        {emp.full_name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={reportFilter}
                    onChange={(e) => {
                      setReportFilter(
                        e.target.value as "Harian" | "Mingguan" | "Bulanan"
                      );
                      setSelectedReportUuids([]);
                    }}
                    className="rounded-lg border border-slate-300 px-1.5 py-1 text-[10px] font-semibold bg-white"
                  >
                    <option value="Harian">Harian</option>
                    <option value="Mingguan">Mingguan</option>
                    <option value="Bulanan">Bulanan</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-between text-[10px] bg-slate-50 px-2.5 py-1.5 rounded-lg border border-slate-200">
                <span className="font-semibold text-slate-600">
                  Tercentang:{" "}
                  <b className="text-[#082A63]">
                    {selectedReportUuids.length > 0
                      ? `${selectedReportUuids.length} baris terpilih`
                      : `Semua (${filteredEntries.length} baris)`}
                  </b>
                </span>
                <button
                  type="button"
                  onClick={toggleSelectAllReport}
                  className="font-bold text-blue-700 underline"
                >
                  {selectedReportUuids.length === filteredEntries.length &&
                  filteredEntries.length > 0
                    ? "Batal Centang"
                    : "Centang Semua"}
                </button>
              </div>

              <div className="p-2 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-extrabold text-[#082A63] uppercase">
                    Inspeksi Laporan (MURINDA • Security Dormitory Batang)
                  </span>
                  <span className="text-[9px] font-bold text-[#0B3B8C] bg-blue-100 px-1.5 py-0.5 rounded">
                    ADMIN INSPEKSI
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => runInspection("XLSX")}
                    className="py-1.5 rounded-lg bg-[#082A63] text-white text-[10px] font-bold"
                  >
                    Inspeksi XLSX
                  </button>
                  <button
                    type="button"
                    onClick={() => runInspection("PDF")}
                    className="py-1.5 rounded-lg bg-[#0B3B8C] text-white text-[10px] font-bold"
                  >
                    Inspeksi PDF
                  </button>
                </div>
                {inspectionMode !== "NONE" && (
                  <div className="p-2 rounded-lg bg-white border border-blue-200 text-[10px] text-slate-700 space-y-1">
                    <div className="font-extrabold text-[#082A63]">
                      MURINDA — Timesheet Absensi Security Dormitory Batang
                    </div>
                    <div>{inspectionNote}</div>
                    <button
                      type="button"
                      onClick={() => setInspectionMode("NONE")}
                      className="text-[9px] font-bold underline text-slate-500"
                    >
                      Tutup Inspeksi
                    </button>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-3 gap-1.5">
                <button
                  type="button"
                  onClick={() => exportReport("XLSX")}
                  className="py-2 rounded-lg bg-emerald-700 text-white text-[11px] font-bold"
                >
                  Download XLSX
                </button>
                <button
                  type="button"
                  onClick={() => exportReport("PDF")}
                  className="py-2 rounded-lg bg-rose-600 text-white text-[11px] font-bold"
                >
                  Download PDF
                </button>
                <button
                  type="button"
                  onClick={() => exportReport("CSV")}
                  className="py-2 rounded-lg bg-slate-800 text-white text-[11px] font-bold"
                >
                  Download CSV
                </button>
              </div>

              {editingUuid && (
                <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-300 space-y-2">
                  <div className="text-[11px] font-extrabold text-amber-900">
                    Edit Catatan Absensi
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <select
                      value={editType}
                      onChange={(e) =>
                        setEditType(e.target.value as "CLOCK_IN" | "CLOCK_OUT")
                      }
                      className="rounded-lg border px-2 py-1.5 text-xs bg-white"
                    >
                      <option value="CLOCK_IN">MASUK</option>
                      <option value="CLOCK_OUT">KELUAR</option>
                    </select>
                    <input
                      type="datetime-local"
                      value={editTimeLocal}
                      onChange={(e) => setEditTimeLocal(e.target.value)}
                      className="rounded-lg border px-2 py-1.5 text-xs bg-white"
                    />
                  </div>
                  <input
                    type="text"
                    placeholder="Catatan edit"
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    className="w-full rounded-lg border px-2.5 py-1.5 text-xs bg-white"
                  />
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => void commitEditEntry()}
                      className="px-3 py-1 rounded-lg bg-emerald-600 text-white text-xs font-bold"
                    >
                      Simpan
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingUuid(null)}
                      className="px-3 py-1 rounded-lg bg-slate-200 text-slate-800 text-xs font-bold"
                    >
                      Batal
                    </button>
                  </div>
                </div>
              )}

              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full text-left border-collapse text-[10px]">
                  <thead>
                    <tr className="bg-[#0B1220] text-white">
                      <th className="p-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={
                            filteredEntries.length > 0 &&
                            selectedReportUuids.length === filteredEntries.length
                          }
                          onChange={toggleSelectAllReport}
                        />
                      </th>
                      <th className="p-1.5">Tanggal</th>
                      <th className="p-1.5">Nama</th>
                      <th className="p-1.5">Device HP</th>
                      <th className="p-1.5">Jenis</th>
                      <th className="p-1.5">Foto</th>
                      <th className="p-1.5">Scan</th>
                      <th className="p-1.5">Telat</th>
                      <th className="p-1.5">Aksi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEntries.length === 0 ? (
                      <tr>
                        <td
                          colSpan={9}
                          className="p-4 text-center text-slate-400"
                        >
                          Belum ada data absensi
                        </td>
                      </tr>
                    ) : (
                      filteredEntries.map((item, idx) => {
                        const emp = employees.find(
                          (e) =>
                            Number(e.id) === Number(item.employee_id) ||
                            (item.emp_code &&
                              e.emp_code.toUpperCase() ===
                                item.emp_code.toUpperCase())
                        );
                        const shift = getEmployeeShiftForIso(
                          emp,
                          item.punched_at
                        );
                        const lateDetail =
                          item.entry_type === "CLOCK_IN"
                            ? calcLateDetail(item.punched_at, shift.startTime)
                            : { lateMinutes: 0, isLate: false, statusNote: "" };
                        const devLabel =
                          item.device_info ||
                          emp?.last_device?.summary ||
                          "HP";
                        return (
                          <tr
                            key={`${item.client_uuid}-${idx}`}
                            className="border-t border-slate-100"
                          >
                            <td className="p-1.5 text-center">
                              <input
                                type="checkbox"
                                checked={selectedReportUuids.includes(
                                  item.client_uuid
                                )}
                                onChange={() =>
                                  toggleReportUuid(item.client_uuid)
                                }
                              />
                            </td>
                            <td className="p-1.5 whitespace-nowrap">
                              {getJakartaDateStr(item.punched_at)}
                            </td>
                            <td className="p-1.5 font-semibold whitespace-nowrap">
                              {item.full_name || emp?.full_name || "Karyawan"}
                            </td>
                            <td className="p-1.5 max-w-[120px] truncate text-[9px] text-slate-600">
                              {devLabel}
                            </td>
                            <td className="p-1.5 whitespace-nowrap">
                              {item.entry_type === "CLOCK_IN"
                                ? "MASUK"
                                : "KELUAR"}
                            </td>
                            <td className="p-1.5 whitespace-nowrap">
                              {item.selfie_data ? (
                                /* eslint-disable-next-line @next/next/no-img-element */
                                <img
                                  src={item.selfie_data}
                                  alt="Wajah TimeMark"
                                  className="w-8 h-8 rounded object-cover border border-slate-300"
                                />
                              ) : (
                                "-"
                              )}
                            </td>
                            <td className="p-1.5 whitespace-nowrap">
                              {formatTimeWIB(item.punched_at)}
                            </td>
                            <td className="p-1.5 whitespace-nowrap font-bold text-rose-600">
                              {lateDetail.isLate
                                ? `${lateDetail.lateMinutes}m`
                                : "0m"}
                            </td>
                            <td className="p-1.5 whitespace-nowrap space-x-1">
                              <button
                                type="button"
                                onClick={() => startEditEntry(item)}
                                className="px-1.5 py-0.5 rounded bg-amber-500 text-white font-bold"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => void removeEntry(item)}
                                className="px-1.5 py-0.5 rounded bg-rose-600 text-white font-bold"
                              >
                                Hapus
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="bg-white rounded-2xl p-3.5 border-t-4 border-t-emerald-600 border border-slate-200/80 shadow-sm space-y-2.5 text-center">
              <h2 className="text-xs font-extrabold text-slate-800 text-left">
                4. QR Code Resmi Kantor Utama
              </h2>
              <p className="text-[10px] text-slate-500 text-left leading-relaxed">
                Cetak atau tampilkan QR Code ini di lokasi kantor. Sistem
                mengunci pemindaian agar karyawan hanya bisa absen{" "}
                <b>MASUK</b> dan <b>KELUAR</b> memakai QR resmi ini.
              </p>

              <input
                type="text"
                value={officeQrCode}
                onChange={(e) => void saveOfficeQrToServer(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-center"
              />

              <div className="p-3 rounded-xl border border-slate-200 bg-white inline-block mx-auto">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qrUrl}
                  alt="QR Code Resmi Kantor Utama"
                  className="w-40 h-40 mx-auto"
                />
                <div className="text-xs font-extrabold text-slate-900 mt-1.5">
                  {officeQrCode}
                </div>
                <div className="text-[10px] text-slate-400">
                  Titik: {targetLocation.latitude}, {targetLocation.longitude} •
                  Radius {targetLocation.radius_meters}m
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <a
                  href={qrUrl}
                  download={`${officeQrCode}.png`}
                  target="_blank"
                  rel="noreferrer"
                  className="py-2 rounded-lg bg-emerald-700 text-white text-xs font-bold"
                >
                  Download PNG
                </a>
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="py-2 rounded-lg bg-slate-900 text-white text-xs font-bold"
                >
                  Cetak QR
                </button>
              </div>
            </section>

            <section
              ref={empFormSectionRef}
              className="bg-white rounded-2xl p-3.5 border border-slate-200/80 shadow-sm space-y-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-xs font-extrabold text-slate-800">
                  5. Panel {isAdminServer ? "Admin" : "Manager"}: Data Karyawan
                  &amp; Koordinat
                </h2>
                {empForm.id > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      setEmpForm({
                        id: 0,
                        emp_code: "",
                        full_name: "",
                        role: "STAFF",
                        department: "Security Dormitory Batang",
                        pin_code: "1001",
                        shift_start_time: "07.00",
                        weekly_schedule: buildDefaultWeeklySchedule("P"),
                      })
                    }
                    className="px-2 py-0.5 rounded bg-slate-200 text-slate-700 text-[10px] font-bold"
                  >
                    Batal Edit
                  </button>
                )}
              </div>

              {empForm.id > 0 && (
                <div className="px-2.5 py-1.5 rounded-lg bg-amber-50 border border-amber-300 text-[10px] font-bold text-amber-900">
                  Sedang Mengedit: {empForm.full_name} ({empForm.emp_code})
                </div>
              )}

              <div className="space-y-1.5">
                <input
                  type="text"
                  placeholder="ID (cth: LJ-SCRTY-MPI.22112026.0004)"
                  value={empForm.emp_code}
                  onChange={(e) =>
                    setEmpForm((p) => ({ ...p, emp_code: e.target.value }))
                  }
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-xs font-bold uppercase"
                />
                <input
                  type="text"
                  placeholder="Nama Lengkap"
                  value={empForm.full_name}
                  onChange={(e) =>
                    setEmpForm((p) => ({ ...p, full_name: e.target.value }))
                  }
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-xs"
                />
                <div className="grid grid-cols-3 gap-1.5">
                  <select
                    value={empForm.role}
                    onChange={(e) =>
                      setEmpForm((p) => ({
                        ...p,
                        role: e.target.value as RoleType,
                      }))
                    }
                    className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs bg-white"
                  >
                    <option value="STAFF">STAFF</option>
                    <option value="MANAGER">MANAGER</option>
                    {isAdminServer && <option value="ADMIN">ADMIN</option>}
                  </select>
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="PIN"
                    value={empForm.pin_code}
                    onChange={(e) =>
                      setEmpForm((p) => ({ ...p, pin_code: e.target.value }))
                    }
                    className="rounded-lg border border-blue-400 bg-blue-50/40 px-2 py-1.5 text-xs font-bold text-center"
                  />
                  <select
                    value={empForm.shift_start_time}
                    onChange={(e) => {
                      const val = e.target.value;
                      const code = shiftTimeToCode(val);
                      setEmpForm((p) => ({
                        ...p,
                        shift_start_time: val,
                        weekly_schedule: p.id
                          ? { ...p.weekly_schedule, Senin: code }
                          : buildDefaultWeeklySchedule(code),
                      }));
                    }}
                    className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs bg-white"
                  >
                    {SHIFT_OPTIONS.map((opt) => (
                      <option key={opt.time} value={opt.time}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="p-2 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5">
                  <div className="text-[10px] font-extrabold text-slate-700">
                    Jadwal Keberangkatan Senin – Minggu (P: 07.00-15.00 • S: 15.00-23.00 • M: 23.00-07.00 •{" "}
                    <span className="text-rose-600">OFF: Libur</span>)
                  </div>
                  <div className="grid grid-cols-7 gap-1 text-center">
                    {DAYS_OF_WEEK.map((day) => {
                      const code = empForm.weekly_schedule[day] || "P";
                      return (
                        <div key={day} className="space-y-0.5">
                          <div className="text-[9px] font-bold text-slate-600">
                            {day.slice(0, 3)}
                          </div>
                          <select
                            value={code}
                            onChange={(e) => {
                              const nextCode = e.target.value as ShiftCode;
                              setEmpForm((p) => ({
                                ...p,
                                weekly_schedule: {
                                  ...p.weekly_schedule,
                                  [day]: nextCode,
                                },
                              }));
                            }}
                            className={`w-full rounded border px-0.5 py-1 text-[10px] font-extrabold text-center bg-white ${
                              code === "OFF"
                                ? "text-rose-600 border-rose-400 bg-rose-50"
                                : "text-slate-800 border-slate-300"
                            }`}
                          >
                            <option value="P">P</option>
                            <option value="S">S</option>
                            <option value="M">M</option>
                            <option value="OFF" className="text-rose-600 font-bold">
                              OFF
                            </option>
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void saveEmployee()}
                  className="w-full py-2 rounded-lg bg-blue-600 text-white text-xs font-bold"
                >
                  {empForm.id ? "Simpan Edit Karyawan" : "Simpan Karyawan"}
                </button>
              </div>

              <div className="space-y-1.5 pt-1">
                {employees.map((emp) => {
                  const wk = sanitizeWeeklySchedule(
                    emp.weekly_schedule,
                    shiftTimeToCode(emp.shift_start_time)
                  );
                  const isLockedCode = LOCKED_STAFF_CODES.includes(
                    emp.emp_code.toUpperCase() as (typeof LOCKED_STAFF_CODES)[number]
                  );
                  return (
                    <div
                      key={emp.emp_code}
                      className={`p-2 rounded-lg border space-y-1 text-xs ${
                        empForm.emp_code.toUpperCase() ===
                        emp.emp_code.toUpperCase()
                          ? "bg-amber-50 border-amber-400"
                          : "bg-slate-50 border-slate-200/70"
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-1.5">
                        <div className="break-all">
                          <span className="font-bold">{emp.full_name}</span> (
                          {emp.emp_code}) • PIN: <b>{emp.pin_code}</b> •{" "}
                          {emp.role}
                        </div>
                        <div className="flex gap-1">
                          <button
                            type="button"
                            onClick={() => beginEditEmployeeCard(emp)}
                            className="px-2 py-0.5 rounded bg-amber-500 text-white text-[10px] font-bold"
                          >
                            Edit
                          </button>
                          {emp.role !== "ADMIN" && !isLockedCode && (
                            <button
                              type="button"
                              onClick={() => void deleteEmployee(emp)}
                              className="px-2 py-0.5 rounded bg-rose-600 text-white text-[10px] font-bold"
                            >
                              Hapus
                            </button>
                          )}
                        </div>
                      </div>
                      {emp.last_device?.summary && (
                        <div className="text-[9px] text-slate-500 truncate">
                          HP Login: {emp.last_device.summary}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-1 text-[9px]">
                        {DAYS_OF_WEEK.map((d) => {
                          const c = wk[d] || "P";
                          return (
                            <span
                              key={d}
                              className={`px-1.5 py-0.5 rounded font-bold ${
                                c === "OFF"
                                  ? "bg-rose-100 text-rose-600 font-extrabold"
                                  : "bg-slate-200/80 text-slate-700"
                              }`}
                            >
                              {d.slice(0, 3)}: {c}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="pt-2.5 border-t border-slate-100 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-extrabold text-slate-700">
                    Atur Titik Koordinat &amp; Radius
                  </span>
                  <button
                    type="button"
                    onClick={fillFromCurrentGps}
                    className="px-2 py-0.5 rounded bg-slate-200 hover:bg-slate-300 text-slate-800 text-[10px] font-bold"
                  >
                    Isi dari GPS Saat Ini
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="Latitude"
                    value={latInput}
                    onChange={(e) => setLatInput(e.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-mono"
                  />
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="Longitude"
                    value={lngInput}
                    onChange={(e) => setLngInput(e.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-mono"
                  />
                  <input
                    type="number"
                    placeholder="Radius (m)"
                    value={radiusInput}
                    onChange={(e) => setRadiusInput(e.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void saveCustomLocation()}
                  className="w-full py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-bold"
                >
                  Simpan Titik Koordinat &amp; Radius
                </button>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
