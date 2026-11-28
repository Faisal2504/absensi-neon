import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type ShiftCode = "P" | "S" | "M" | "OFF";
type DayKey = "Senin" | "Selasa" | "Rabu" | "Kamis" | "Jumat" | "Sabtu" | "Minggu";
type WeeklyScheduleMap = Record<DayKey, ShiftCode>;

const DAYS_OF_WEEK: DayKey[] = [
  "Senin",
  "Selasa",
  "Rabu",
  "Kamis",
  "Jumat",
  "Sabtu",
  "Minggu",
];

function defaultWeekly(code: ShiftCode = "P"): WeeklyScheduleMap {
  return {
    Senin: code,
    Selasa: code,
    Rabu: code,
    Kamis: code,
    Jumat: code,
    Sabtu: code,
    Minggu: "OFF",
  };
}

function sanitizeWeekly(raw: unknown, fallback: ShiftCode = "P"): WeeklyScheduleMap {
  const base = defaultWeekly(fallback);
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Record<string, unknown>;
  for (const d of DAYS_OF_WEEK) {
    const val = String(obj[d] || "").trim().toUpperCase();
    if (val === "P" || val === "S" || val === "M" || val === "OFF") {
      base[d] = val as ShiftCode;
    }
  }
  return base;
}

function getSql() {
  const url =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.NEON_DATABASE_URL ||
    "";
  if (!url) return null;
  return neon(url);
}

let schemaReady = false;

async function ensureSchema(sql: ReturnType<typeof neon>) {
  if (schemaReady) return;

  await sql`
    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      emp_code TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'STAFF',
      department TEXT NOT NULL DEFAULT 'Security Dormitory Batang',
      pin_code TEXT NOT NULL DEFAULT '1001',
      shift_start_time TEXT NOT NULL DEFAULT '07.00',
      weekly_schedule JSONB,
      last_device JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin_code TEXT NOT NULL DEFAULT '1001'`;
  await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS shift_start_time TEXT NOT NULL DEFAULT '07.00'`;
  await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS weekly_schedule JSONB`;
  await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_device JSONB`;

  await sql`
    CREATE TABLE IF NOT EXISTS locations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Kantor Utama',
      latitude DOUBLE PRECISION NOT NULL DEFAULT -6.9148609,
      longitude DOUBLE PRECISION NOT NULL DEFAULT 109.744683,
      radius_meters INTEGER NOT NULL DEFAULT 2000
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS time_entries (
      id SERIAL PRIMARY KEY,
      client_uuid TEXT UNIQUE NOT NULL,
      employee_id INTEGER NOT NULL,
      entry_type TEXT NOT NULL,
      punched_at TIMESTAMPTZ NOT NULL,
      is_offline_sync BOOLEAN DEFAULT FALSE,
      qr_code TEXT,
      mode TEXT,
      notes TEXT,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      distance_meters INTEGER,
      is_within_geofence BOOLEAN DEFAULT TRUE,
      selfie_data TEXT,
      face_detected BOOLEAN DEFAULT FALSE,
      device_info TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS selfie_data TEXT`;
  await sql`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS face_detected BOOLEAN DEFAULT FALSE`;
  await sql`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS device_info TEXT`;
  await sql`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS qr_code TEXT`;
  await sql`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS mode TEXT`;
  await sql`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS notes TEXT`;
  await sql`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION`;
  await sql`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION`;
  await sql`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS distance_meters INTEGER`;
  await sql`ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS is_within_geofence BOOLEAN DEFAULT TRUE`;

  await sql`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  const existingEmps = await sql`SELECT COUNT(*)::int AS cnt FROM employees`;
  if ((existingEmps[0]?.cnt ?? 0) === 0) {
    const seeds = [
      {
        emp_code: "ADM-001",
        full_name: "Admin Operasional",
        role: "ADMIN",
        department: "Administrator",
        pin_code: "0000",
        shift_start_time: "07.00",
        weekly_schedule: defaultWeekly("P"),
      },
      {
        emp_code: "MGR-001",
        full_name: "Manager Operasional",
        role: "MANAGER",
        department: "Manajemen",
        pin_code: "2026",
        shift_start_time: "07.00",
        weekly_schedule: defaultWeekly("P"),
      },
      {
        emp_code: "AP-SCRTY-MPI.22112026.0001",
        full_name: "ANGGAR PERMADI",
        role: "STAFF",
        department: "Security Dormitory Batang",
        pin_code: "1001",
        shift_start_time: "07.00",
        weekly_schedule: defaultWeekly("P"),
      },
      {
        emp_code: "DDS-SCRTY-MPI.22112026.0002",
        full_name: "Anggota DDS",
        role: "STAFF",
        department: "Security Dormitory Batang",
        pin_code: "1002",
        shift_start_time: "15.00",
        weekly_schedule: defaultWeekly("S"),
      },
      {
        emp_code: "JRA-SCRTY-MPI.22112026.0003",
        full_name: "Anggota JRA",
        role: "STAFF",
        department: "Security Dormitory Batang",
        pin_code: "1003",
        shift_start_time: "23.00",
        weekly_schedule: defaultWeekly("M"),
      },
      {
        emp_code: "LJ-SCRTY-MPI.22112026.0004",
        full_name: "Anggota LJ",
        role: "STAFF",
        department: "Security Dormitory Batang",
        pin_code: "1004",
        shift_start_time: "07.00",
        weekly_schedule: defaultWeekly("P"),
      },
    ];

    for (const s of seeds) {
      await sql`
        INSERT INTO employees (emp_code, full_name, role, department, pin_code, shift_start_time, weekly_schedule)
        VALUES (${s.emp_code}, ${s.full_name}, ${s.role}, ${s.department}, ${s.pin_code}, ${s.shift_start_time}, ${JSON.stringify(s.weekly_schedule)}::jsonb)
        ON CONFLICT (emp_code) DO NOTHING
      `;
    }
  }

  const existingLocs = await sql`SELECT COUNT(*)::int AS cnt FROM locations`;
  if ((existingLocs[0]?.cnt ?? 0) === 0) {
    await sql`
      INSERT INTO locations (id, name, latitude, longitude, radius_meters)
      VALUES (1, 'Kantor Utama', -6.9148609, 109.744683, 2000)
      ON CONFLICT (id) DO NOTHING
    `;
  }

  schemaReady = true;
}

async function fetchFullState(sql: ReturnType<typeof neon>) {
  const empRows = await sql`
    SELECT id, emp_code, full_name, role, department, pin_code, shift_start_time, weekly_schedule, last_device
    FROM employees
    ORDER BY id ASC
  `;

  const weeklySchedules: Record<string, WeeklyScheduleMap> = {};
  const employees = empRows.map((row) => {
    const code = String(row.emp_code || "").trim().toUpperCase();
    const fallback: ShiftCode =
      String(row.shift_start_time || "").includes("15")
        ? "S"
        : String(row.shift_start_time || "").includes("23")
        ? "M"
        : String(row.shift_start_time || "").toUpperCase() === "OFF"
        ? "OFF"
        : "P";
    const parsedWeekly = sanitizeWeekly(row.weekly_schedule, fallback);
    weeklySchedules[code] = parsedWeekly;
    return {
      id: Number(row.id),
      emp_code: code,
      full_name: String(row.full_name || ""),
      role: String(row.role || "STAFF"),
      department: String(row.department || "Security Dormitory Batang"),
      pin_code: String(row.pin_code || "1001"),
      shift_start_time: String(row.shift_start_time || "07.00"),
      weekly_schedule: parsedWeekly,
      last_device: row.last_device || null,
    };
  });

  const locRows = await sql`
    SELECT id, name, latitude, longitude, radius_meters
    FROM locations
    ORDER BY id ASC
  `;

  const entryRows = await sql`
    SELECT
      t.id,
      t.client_uuid,
      t.employee_id,
      t.entry_type,
      t.punched_at,
      t.is_offline_sync,
      t.qr_code,
      t.mode,
      t.notes,
      t.latitude,
      t.longitude,
      t.distance_meters,
      t.is_within_geofence,
      t.selfie_data,
      t.face_detected,
      t.device_info,
      e.full_name,
      e.emp_code
    FROM time_entries t
    LEFT JOIN employees e ON e.id = t.employee_id
    ORDER BY t.punched_at DESC
    LIMIT 500
  `;

  const settingRows = await sql`
    SELECT key, value FROM app_settings WHERE key IN ('schedule_poster', 'office_qr')
  `;
  let schedulePoster = null;
  let officeQr: string | null = null;
  for (const s of settingRows) {
    if (s.key === "schedule_poster") schedulePoster = s.value;
    if (s.key === "office_qr" && typeof s.value === "string") officeQr = s.value;
  }

  return {
    employees,
    weeklySchedules,
    locations: locRows,
    entries: entryRows,
    schedulePoster,
    officeQr,
  };
}

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}

export async function GET() {
  const sql = getSql();
  if (!sql) {
    return noStoreJson({
      ok: true,
      dbConnected: false,
      dbError: "DATABASE_URL belum dikonfigurasi di Vercel",
    });
  }

  try {
    await ensureSchema(sql);
    const state = await fetchFullState(sql);
    return noStoreJson({
      ok: true,
      dbConnected: true,
      serverTime: new Date().toISOString(),
      ...state,
    });
  } catch (err) {
    return noStoreJson(
      {
        ok: false,
        dbConnected: false,
        dbError: err instanceof Error ? err.message : "Gagal terhubung ke Neon",
      },
      500
    );
  }
}

export async function POST(req: NextRequest) {
  const sql = getSql();
  if (!sql) {
    return noStoreJson(
      { ok: false, dbConnected: false, error: "DATABASE_URL belum diatur" },
      500
    );
  }

  try {
    await ensureSchema(sql);
    const body = await req.json();
    const action = String(body?.action || "").toUpperCase();

    if (action === "SUBMIT_PUNCH") {
      const punches = Array.isArray(body?.punches) ? body.punches : [];
      const syncedUuids: string[] = [];

      for (const p of punches) {
        const uuid = String(p.client_uuid || "").trim();
        if (!uuid) continue;

        await sql`
          INSERT INTO time_entries (
            client_uuid,
            employee_id,
            entry_type,
            punched_at,
            is_offline_sync,
            qr_code,
            mode,
            notes,
            latitude,
            longitude,
            distance_meters,
            is_within_geofence,
            selfie_data,
            face_detected,
            device_info
          )
          VALUES (
            ${uuid},
            ${Number(p.employee_id)},
            ${String(p.entry_type || "CLOCK_IN")},
            ${String(p.punched_at || new Date().toISOString())},
            ${Boolean(p.is_offline_sync)},
            ${p.qr_code ? String(p.qr_code) : null},
            ${p.mode ? String(p.mode) : null},
            ${p.notes ? String(p.notes) : null},
            ${p.latitude !== undefined && p.latitude !== null ? Number(p.latitude) : null},
            ${p.longitude !== undefined && p.longitude !== null ? Number(p.longitude) : null},
            ${p.distance_meters !== undefined && p.distance_meters !== null ? Number(p.distance_meters) : null},
            ${p.is_within_geofence !== undefined ? Boolean(p.is_within_geofence) : true},
            ${p.selfie_data ? String(p.selfie_data) : null},
            ${Boolean(p.face_detected)},
            ${p.device_info ? String(p.device_info) : null}
          )
          ON CONFLICT (client_uuid) DO NOTHING
        `;
        syncedUuids.push(uuid);
      }

      const state = await fetchFullState(sql);
      return noStoreJson({
        ok: true,
        dbConnected: true,
        syncedCount: syncedUuids.length,
        syncedUuids,
        ...state,
      });
    }

    if (action === "SAVE_EMPLOYEE") {
      const p = body?.payload || {};
      const empCode = String(p.emp_code || "").trim().toUpperCase();
      const fullName = String(p.full_name || "").trim();
      const role = String(p.role || "STAFF").toUpperCase();
      const department = String(p.department || "Security Dormitory Batang").trim();
      const pinCode = String(p.pin_code || "1001").trim();
      const shiftStartTime = String(p.shift_start_time || "07.00").trim();
      const weeklySchedule = sanitizeWeekly(p.weekly_schedule, "P");

      if (!empCode || !fullName) {
        return noStoreJson({ ok: false, error: "ID dan Nama wajib diisi" }, 400);
      }

      if (p.id && Number(p.id) > 0 && Number(p.id) < 2000000000) {
        await sql`
          UPDATE employees
          SET
            emp_code = ${empCode},
            full_name = ${fullName},
            role = ${role},
            department = ${department},
            pin_code = ${pinCode},
            shift_start_time = ${shiftStartTime},
            weekly_schedule = ${JSON.stringify(weeklySchedule)}::jsonb
          WHERE id = ${Number(p.id)} OR emp_code = ${empCode}
        `;
      } else {
        await sql`
          INSERT INTO employees (emp_code, full_name, role, department, pin_code, shift_start_time, weekly_schedule)
          VALUES (${empCode}, ${fullName}, ${role}, ${department}, ${pinCode}, ${shiftStartTime}, ${JSON.stringify(weeklySchedule)}::jsonb)
          ON CONFLICT (emp_code) DO UPDATE SET
            full_name = EXCLUDED.full_name,
            role = EXCLUDED.role,
            department = EXCLUDED.department,
            pin_code = EXCLUDED.pin_code,
            shift_start_time = EXCLUDED.shift_start_time,
            weekly_schedule = EXCLUDED.weekly_schedule
        `;
      }

      if (body?.weeklySchedules && typeof body.weeklySchedules === "object") {
        for (const [codeKey, schedVal] of Object.entries(body.weeklySchedules)) {
          const cleanK = String(codeKey).trim().toUpperCase();
          const cleanS = sanitizeWeekly(schedVal, "P");
          await sql`
            UPDATE employees
            SET weekly_schedule = ${JSON.stringify(cleanS)}::jsonb
            WHERE UPPER(emp_code) = ${cleanK}
          `;
        }
      }

      const state = await fetchFullState(sql);
      return noStoreJson({ ok: true, dbConnected: true, ...state });
    }

    if (action === "DELETE_EMPLOYEE") {
      const id = Number(body?.payload?.id || 0);
      if (id > 0) {
        await sql`DELETE FROM employees WHERE id = ${id}`;
      }
      const state = await fetchFullState(sql);
      return noStoreJson({ ok: true, dbConnected: true, ...state });
    }

    if (action === "SAVE_SCHEDULE_POSTER") {
      const poster = body?.payload?.poster || null;
      const weeklySchedules = body?.payload?.weeklySchedules || {};
      const incomingEmployees = Array.isArray(body?.payload?.employees)
        ? body.payload.employees
        : [];

      if (poster) {
        await sql`
          INSERT INTO app_settings (key, value, updated_at)
          VALUES ('schedule_poster', ${JSON.stringify(poster)}::jsonb, NOW())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `;
      }

      for (const emp of incomingEmployees) {
        const code = String(emp.emp_code || "").trim().toUpperCase();
        if (!code) continue;
        const wk = sanitizeWeekly(
          weeklySchedules[code] || emp.weekly_schedule,
          "P"
        );
        await sql`
          UPDATE employees
          SET
            full_name = ${String(emp.full_name || "")},
            shift_start_time = ${String(emp.shift_start_time || "07.00")},
            weekly_schedule = ${JSON.stringify(wk)}::jsonb
          WHERE UPPER(emp_code) = ${code}
        `;
      }

      const state = await fetchFullState(sql);
      return noStoreJson({ ok: true, dbConnected: true, ...state });
    }

    if (action === "DEVICE_LOGIN") {
      const p = body?.payload || {};
      const empCode = String(p.emp_code || "").trim().toUpperCase();
      const detail = p.device_detail || { summary: p.device_info || "Perangkat HP" };
      if (empCode) {
        await sql`
          UPDATE employees
          SET last_device = ${JSON.stringify(detail)}::jsonb
          WHERE UPPER(emp_code) = ${empCode}
        `;
      }
      const state = await fetchFullState(sql);
      return noStoreJson({ ok: true, dbConnected: true, ...state });
    }

    if (action === "UPDATE_ENTRY") {
      const p = body?.payload || {};
      const clientUuid = String(p.client_uuid || "").trim();
      const entryType = String(p.entry_type || "CLOCK_IN");
      const punchedAt = String(p.punched_at || new Date().toISOString());
      const notes = String(p.notes || "");

      if (clientUuid) {
        await sql`
          UPDATE time_entries
          SET entry_type = ${entryType}, punched_at = ${punchedAt}, notes = ${notes}
          WHERE client_uuid = ${clientUuid}
        `;
      } else if (p.id) {
        await sql`
          UPDATE time_entries
          SET entry_type = ${entryType}, punched_at = ${punchedAt}, notes = ${notes}
          WHERE id = ${Number(p.id)}
        `;
      }

      const state = await fetchFullState(sql);
      return noStoreJson({ ok: true, dbConnected: true, ...state });
    }

    if (action === "DELETE_ENTRY") {
      const p = body?.payload || {};
      if (p.client_uuid) {
        await sql`DELETE FROM time_entries WHERE client_uuid = ${String(p.client_uuid)}`;
      }
      if (p.id) {
        await sql`DELETE FROM time_entries WHERE id = ${Number(p.id)}`;
      }
      const state = await fetchFullState(sql);
      return noStoreJson({ ok: true, dbConnected: true, ...state });
    }

    if (action === "SAVE_LOCATION") {
      const p = body?.payload || {};
      const id = Number(p.id) || 1;
      const name = String(p.name || "Kantor Utama");
      const lat = Number(p.latitude);
      const lng = Number(p.longitude);
      const radius = Math.max(10, Number(p.radius_meters) || 2000);

      await sql`
        INSERT INTO locations (id, name, latitude, longitude, radius_meters)
        VALUES (${id}, ${name}, ${lat}, ${lng}, ${radius})
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude,
          radius_meters = EXCLUDED.radius_meters
      `;

      const state = await fetchFullState(sql);
      return noStoreJson({ ok: true, dbConnected: true, ...state });
    }

    if (action === "SAVE_QR") {
      const qr = String(body?.payload?.qrCode || "").trim().toUpperCase();
      if (qr) {
        await sql`
          INSERT INTO app_settings (key, value, updated_at)
          VALUES ('office_qr', ${JSON.stringify(qr)}::jsonb, NOW())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `;
      }
      const state = await fetchFullState(sql);
      return noStoreJson({ ok: true, dbConnected: true, ...state });
    }

    return noStoreJson({ ok: false, error: `Aksi tidak dikenal: ${action}` }, 400);
  } catch (err) {
    return noStoreJson(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Terjadi kesalahan server",
      },
      500
    );
  }
}
