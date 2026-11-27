import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

async function ensureTables() {
  await sql`
    CREATE TABLE IF NOT EXISTS karyawan (
      id_karyawan VARCHAR(50) PRIMARY KEY,
      nama VARCHAR(100) NOT NULL,
      pin VARCHAR(20) NOT NULL,
      role VARCHAR(20) DEFAULT 'karyawan'
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS jadwal_keberangkatan (
      id_karyawan VARCHAR(50) NOT NULL,
      nama VARCHAR(100) NOT NULL,
      tanggal DATE NOT NULL,
      jam_berangkat VARCHAR(10) NOT NULL,
      jam_pulang VARCHAR(10) DEFAULT '17:00',
      toleransi_menit INT DEFAULT 10,
      lat DOUBLE PRECISION DEFAULT -6.9148609,
      lng DOUBLE PRECISION DEFAULT 109.7446830,
      radius_meter INT DEFAULT 150,
      PRIMARY KEY (id_karyawan, tanggal)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS log_absensi (
      id_log VARCHAR(100) PRIMARY KEY,
      tanggal DATE NOT NULL,
      id_karyawan VARCHAR(50) NOT NULL,
      nama VARCHAR(100) NOT NULL,
      jenis VARCHAR(20) NOT NULL,
      waktu_scan VARCHAR(10) NOT NULL,
      jadwal_berangkat VARCHAR(10) NOT NULL,
      telat_menit INT DEFAULT 0,
      status VARCHAR(30) NOT NULL,
      koordinat_gps VARCHAR(60),
      jarak_meter INT DEFAULT 0,
      mode_rekam VARCHAR(20) DEFAULT 'Online',
      qr_id VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;

  const existing = await sql`SELECT COUNT(*)::int AS total FROM karyawan`;
  if ((existing[0]?.total ?? 0) === 0) {
    await sql`
      INSERT INTO karyawan (id_karyawan, nama, pin, role) VALUES
      ('ADM-001', 'Admin Operasional', '9999', 'admin'),
      ('KRY-001', 'Budi Santoso', '1234', 'karyawan')
      ON CONFLICT (id_karyawan) DO NOTHING
    `;
  }
}

export async function GET() {
  try {
    await ensureTables();
    const rows = await sql`
      SELECT id_karyawan, nama, pin, role
      FROM karyawan
      ORDER BY id_karyawan ASC
    `;
    return NextResponse.json({ status: 'ok', data: rows });
  } catch (error: unknown) {
    return NextResponse.json({ status: 'error', message: String(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    await ensureTables();
    const body = await req.json();

    if (body.action === 'login') {
      const id = String(body.id_karyawan || '').trim().toUpperCase();
      const pin = String(body.pin || '').trim();
      const users = await sql`
        SELECT id_karyawan, nama, pin, role
        FROM karyawan
        WHERE id_karyawan = ${id} AND pin = ${pin}
        LIMIT 1
      `;
      if (users.length === 0) {
        return NextResponse.json({ status: 'error', message: 'ID atau PIN salah!' }, { status: 401 });
      }
      return NextResponse.json({ status: 'ok', user: users[0] });
    }

    const id_karyawan = String(body.id_karyawan || '').trim().toUpperCase();
    const nama = String(body.nama || '').trim();
    const pin = String(body.pin || '1234').trim();
    const role = body.role === 'admin' ? 'admin' : 'karyawan';

    if (!id_karyawan || !nama) {
      return NextResponse.json({ status: 'error', message: 'ID dan Nama wajib diisi!' }, { status: 400 });
    }

    await sql`
      INSERT INTO karyawan (id_karyawan, nama, pin, role)
      VALUES (${id_karyawan}, ${nama}, ${pin}, ${role})
      ON CONFLICT (id_karyawan) DO UPDATE SET
        nama = EXCLUDED.nama,
        pin = EXCLUDED.pin,
        role = EXCLUDED.role
    `;
    return NextResponse.json({ status: 'ok' });
  } catch (error: unknown) {
    return NextResponse.json({ status: 'error', message: String(error) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const id = String(searchParams.get('id') || '').trim().toUpperCase();
    if (!id) return NextResponse.json({ status: 'error', message: 'ID wajib diisi' }, { status: 400 });
    await sql`DELETE FROM karyawan WHERE id_karyawan = ${id}`;
    return NextResponse.json({ status: 'ok' });
  } catch (error: unknown) {
    return NextResponse.json({ status: 'error', message: String(error) }, { status: 500 });
  }
}

      
  
