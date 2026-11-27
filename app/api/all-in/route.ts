import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";

function getSql() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL belum diatur di Vercel");
  return neon(url);
}

async function ensureTables(sql: ReturnType<typeof neon>) {
  await sql`
    CREATE TABLE IF NOT EXISTS allin_settings (
      id INT PRIMARY KEY DEFAULT 1,
      office_name TEXT NOT NULL DEFAULT 'Kantor Utama MPI-BTG',
      qr_code TEXT NOT NULL DEFAULT 'ABSENSI-KANTOR-MPI-BTG',
      latitude DOUBLE PRECISION NOT NULL DEFAULT -6.6167,
      longitude DOUBLE PRECISION NOT NULL DEFAULT 110.6667,
      radius_meters INT NOT NULL DEFAULT 150,
      shift_start TEXT NOT NULL DEFAULT '07:00',
      late_tolerance INT NOT NULL DEFAULT 10
    )
  `;
  await sql`
    INSERT INTO allin_settings (id, office_name, qr_code, latitude, longitude, radius_meters, shift_start, late_tolerance)
    VALUES (1, 'Kantor Utama MPI-BTG', 'ABSENSI-KANTOR-MPI-BTG', -6.6167, 110.6667, 150, '07:00', 10)
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS allin_employees (
      id SERIAL PRIMARY KEY,
      emp_code TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'STAFF',
      department TEXT NOT NULL DEFAULT 'Operasional',
      pin_code TEXT NOT NULL DEFAULT '1234',
      shift_start TEXT NOT NULL DEFAULT '07:00'
    )
  `;
  await sql`
    INSERT INTO allin_employees (emp_code, full_name, role, department, pin_code, shift_start)
    VALUES ('ADM-001', 'Admin Operasional', 'ADMIN', 'Manajemen', '0000', '07:00')
    ON CONFLICT (emp_code) DO NOTHING
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS allin_attendance (
      id SERIAL PRIMARY KEY,
      client_uuid TEXT UNIQUE NOT NULL,
      emp_code TEXT NOT NULL,
      full_name TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      date_str TEXT NOT NULL,
      time_str TEXT NOT NULL,
      is_late BOOLEAN NOT NULL DEFAULT FALSE,
      late_minutes INT NOT NULL DEFAULT 0,
      distance_meters INT DEFAULT 0,
      status_label TEXT NOT NULL DEFAULT 'VALID',
      sync_mode TEXT NOT NULL DEFAULT 'ONLINE',
      notes TEXT DEFAULT ''
    )
  `;
}

function calcLate(timeStr: string, shiftStart: string, tolerance: number) {
  const [h1, m1] = timeStr.slice(0, 5).split(":").map(Number);
  const [h2, m2] = shiftStart.slice(0, 5).split(":").map(Number);
  if (isNaN(h1) || isNaN(h2)) return { isLate: false, lateMin: 0 };
  const diff = h1 * 60 + m1 - (h2 * 60 + m2);
  return diff > tolerance ? { isLate: true, lateMin: diff } : { isLate: false, lateMin: 0 };
}

export async function GET() {
  try {
    const sql = getSql();
    await ensureTables(sql);
    const [settings] = await sql`SELECT * FROM allin_settings WHERE id = 1`;
    const employees = await sql`SELECT * FROM allin_employees ORDER BY id ASC`;
    const attendance = await sql`SELECT * FROM allin_attendance ORDER BY date_str DESC, time_str DESC, id DESC LIMIT 500`;
    return NextResponse.json({ ok: true, settings, employees, attendance });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Gagal memuat server";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const sql = getSql();
    await ensureTables(sql);
    const body = await req.json();
    const { action, payload } = body;

    if (action === "SAVE_EMPLOYEE") {
      const code = String(payload.emp_code || "").trim().toUpperCase();
      const name = String(payload.full_name || "").trim();
      const role = payload.role === "ADMIN" ? "ADMIN" : "STAFF";
      const dept = String(payload.department || "Operasional").trim();
      const pin = String(payload.pin_code || "1234").trim();
      const shift = String(payload.shift_start || "07:00").trim();
      if (!code || !name) return NextResponse.json({ ok: false, error: "ID & Nama wajib diisi" }, { status: 400 });

      if (payload.id) {
        await sql`
          UPDATE allin_employees
          SET emp_code = ${code}, full_name = ${name}, role = ${role}, department = ${dept}, pin_code = ${pin}, shift_start = ${shift}
          WHERE id = ${Number(payload.id)}
        `;
      } else {
        await sql`
          INSERT INTO allin_employees (emp_code, full_name, role, department, pin_code, shift_start)
          VALUES (${code}, ${name}, ${role}, ${dept}, ${pin}, ${shift})
          ON CONFLICT (emp_code) DO UPDATE
          SET full_name = EXCLUDED.full_name, role = EXCLUDED.role, department = EXCLUDED.department, pin_code = EXCLUDED.pin_code, shift_start = EXCLUDED.shift_start
        `;
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "DELETE_EMPLOYEE") {
      await sql`DELETE FROM allin_employees WHERE id = ${Number(payload.id)} AND emp_code <> 'ADM-001'`;
      return NextResponse.json({ ok: true });
    }

    if (action === "IMPORT_EMPLOYEES") {
      const list = Array.isArray(payload.rows) ? payload.rows : [];
      for (const r of list) {
        if (!r.emp_code || !r.full_name) continue;
        await sql`
          INSERT INTO allin_employees (emp_code, full_name, role, department, pin_code, shift_start)
          VALUES (${String(r.emp_code).trim().toUpperCase()}, ${String(r.full_name).trim()}, ${r.role === "ADMIN" ? "ADMIN" : "STAFF"}, ${String(r.department || "Operasional")}, ${String(r.pin_code || "1234")}, ${String(r.shift_start || "07:00")})
          ON CONFLICT (emp_code) DO UPDATE
          SET full_name = EXCLUDED.full_name, department = EXCLUDED.department, shift_start = EXCLUDED.shift_start
        `;
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "RECORD_PUNCH") {
      const items = Array.isArray(payload.items) ? payload.items : [payload];
      const [cfg] = await sql`SELECT * FROM allin_settings WHERE id = 1`;
      for (const it of items) {
        const emps = await sql`SELECT * FROM allin_employees WHERE emp_code = ${String(it.emp_code)} LIMIT 1`;
        const emp = emps[0];
        const shift = emp?.shift_start || cfg?.shift_start || "07:00";
        const late = it.entry_type === "MASUK" ? calcLate(it.time_str, shift, Number(cfg?.late_tolerance || 10)) : { isLate: false, lateMin: 0 };
        await sql`
          INSERT INTO allin_attendance (client_uuid, emp_code, full_name, entry_type, date_str, time_str, is_late, late_minutes, distance_meters, status_label, sync_mode, notes)
          VALUES (
            ${String(it.client_uuid)},
            ${String(it.emp_code)},
            ${String(emp?.full_name || it.full_name || it.emp_code)},
            ${String(it.entry_type)},
            ${String(it.date_str)},
            ${String(it.time_str)},
            ${late.isLate},
            ${late.lateMin},
            ${Number(it.distance_meters || 0)},
            ${String(it.status_label || "VALID")},
            ${String(it.sync_mode || "ONLINE")},
            ${String(it.notes || "")}
          )
          ON CONFLICT (client_uuid) DO NOTHING
        `;
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "EDIT_ATTENDANCE") {
      if (payload.id) {
        await sql`
          UPDATE allin_attendance
          SET entry_type = ${String(payload.entry_type)},
              date_str = ${String(payload.date_str)},
              time_str = ${String(payload.time_str)},
              is_late = ${Boolean(payload.is_late)},
              late_minutes = ${Number(payload.late_minutes || 0)},
              status_label = ${String(payload.status_label || "VALID")},
              notes = ${String(payload.notes || "")}
          WHERE id = ${Number(payload.id)}
        `;
      } else {
        const uuid = `MANUAL-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        await sql`
          INSERT INTO allin_attendance (client_uuid, emp_code, full_name, entry_type, date_str, time_str, is_late, late_minutes, distance_meters, status_label, sync_mode, notes)
          VALUES (
            ${uuid}, ${String(payload.emp_code)}, ${String(payload.full_name)}, ${String(payload.entry_type)},
            ${String(payload.date_str)}, ${String(payload.time_str)}, ${Boolean(payload.is_late)},
            ${Number(payload.late_minutes || 0)}, 0, ${String(payload.status_label || "MANUAL ADMIN")}, 'ADMIN', ${String(payload.notes || "")}
          )
        `;
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "DELETE_ATTENDANCE") {
      await sql`DELETE FROM allin_attendance WHERE id = ${Number(payload.id)}`;
      return NextResponse.json({ ok: true });
    }

    if (action === "SAVE_SETTINGS") {
      await sql`
        UPDATE allin_settings
        SET office_name = ${String(payload.office_name)},
            qr_code = ${String(payload.qr_code).trim()},
            latitude = ${Number(payload.latitude)},
            longitude = ${Number(payload.longitude)},
            radius_meters = ${Number(payload.radius_meters)},
            shift_start = ${String(payload.shift_start)},
            late_tolerance = ${Number(payload.late_tolerance)}
        WHERE id = 1
      `;
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: "Aksi tidak dikenal" }, { status: 400 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Terjadi kesalahan server";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
