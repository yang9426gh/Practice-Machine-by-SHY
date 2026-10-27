import os
import sqlite3
from typing import Optional


def db_path(data_dir: str) -> str:
    return os.path.join(data_dir, "index.db")


def init_db(data_dir: str) -> None:
    os.makedirs(data_dir, exist_ok=True)
    path = db_path(data_dir)
    con = sqlite3.connect(path)
    try:
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS tracks (
              video_id TEXT PRIMARY KEY,
              source_url TEXT,
              task_id TEXT,
              title TEXT,
              artist TEXT,
              cover_url TEXT,
              vocals_path TEXT,
              no_vocals_path TEXT,
              created_at INTEGER DEFAULT (strftime('%s','now')),
              updated_at INTEGER DEFAULT (strftime('%s','now'))
            );
            """
        )

        # lightweight migrations (add columns if this DB was created before they existed)
        cols = {row[1] for row in con.execute("PRAGMA table_info(tracks)").fetchall()}
        for name, ddl in [
            ("title", "ALTER TABLE tracks ADD COLUMN title TEXT"),
            ("artist", "ALTER TABLE tracks ADD COLUMN artist TEXT"),
            ("cover_url", "ALTER TABLE tracks ADD COLUMN cover_url TEXT"),
        ]:
            if name not in cols:
                con.execute(ddl)

        con.execute(
            """
            CREATE TABLE IF NOT EXISTS presets (
              id TEXT PRIMARY KEY,
              name TEXT,
              source_url TEXT,
              video_id TEXT,
              title TEXT,
              thumbnail_url TEXT,
              semitones INTEGER DEFAULT 0,
              master_volume REAL DEFAULT 1.0,
              vocal_volume REAL DEFAULT 1.0,
              created_at INTEGER DEFAULT (strftime('%s','now')),
              updated_at INTEGER DEFAULT (strftime('%s','now'))
            );
            """
        )

        # migrations for presets
        pcols = {row[1] for row in con.execute("PRAGMA table_info(presets)").fetchall()}
        for name, ddl in [
            ("title", "ALTER TABLE presets ADD COLUMN title TEXT"),
            ("thumbnail_url", "ALTER TABLE presets ADD COLUMN thumbnail_url TEXT"),
            ("bpm", "ALTER TABLE presets ADD COLUMN bpm REAL"),
            ("key_tonic", "ALTER TABLE presets ADD COLUMN key_tonic TEXT"),
            ("key_mode", "ALTER TABLE presets ADD COLUMN key_mode TEXT"),
            ("lyrics_lrc", "ALTER TABLE presets ADD COLUMN lyrics_lrc TEXT"),
        ]:
            if name not in pcols:
                con.execute(ddl)

        con.commit()
    finally:
        con.close()


def upsert_track(
    data_dir: str,
    *,
    video_id: str,
    source_url: str,
    task_id: str,
    vocals_path: str,
    no_vocals_path: str,
    title: Optional[str] = None,
    artist: Optional[str] = None,
    cover_url: Optional[str] = None,
) -> None:
    con = sqlite3.connect(db_path(data_dir))
    try:
        con.execute(
            """
            INSERT INTO tracks(video_id, source_url, task_id, title, artist, cover_url, vocals_path, no_vocals_path)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(video_id) DO UPDATE SET
              source_url=excluded.source_url,
              task_id=excluded.task_id,
              title=COALESCE(excluded.title, tracks.title),
              artist=COALESCE(excluded.artist, tracks.artist),
              cover_url=COALESCE(excluded.cover_url, tracks.cover_url),
              vocals_path=excluded.vocals_path,
              no_vocals_path=excluded.no_vocals_path,
              updated_at=strftime('%s','now');
            """
        , (video_id, source_url, task_id, title, artist, cover_url, vocals_path, no_vocals_path))
        con.commit()
    finally:
        con.close()


def get_track(data_dir: str, video_id: str) -> Optional[dict]:
    con = sqlite3.connect(db_path(data_dir))
    con.row_factory = sqlite3.Row
    try:
        row = con.execute("SELECT * FROM tracks WHERE video_id=?", (video_id,)).fetchone()
        if not row:
            return None
        return dict(row)
    finally:
        con.close()


def get_preset(data_dir: str, id: str) -> Optional[dict]:
    con = sqlite3.connect(db_path(data_dir))
    con.row_factory = sqlite3.Row
    try:
        row = con.execute("SELECT * FROM presets WHERE id=?", (id,)).fetchone()
        if not row:
            return None
        return dict(row)
    finally:
        con.close()


def list_tracks(data_dir: str, limit: int = 50) -> list[dict]:
    con = sqlite3.connect(db_path(data_dir))
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            "SELECT * FROM tracks ORDER BY updated_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        con.close()


def upsert_preset(
    data_dir: str,
    *,
    id: str,
    name: str,
    source_url: str,
    video_id: str,
    title: Optional[str] = None,
    thumbnail_url: Optional[str] = None,
    bpm: Optional[float] = None,
    key_tonic: Optional[str] = None,
    key_mode: Optional[str] = None,
    semitones: int = 0,
    master_volume: float = 1.0,
    vocal_volume: float = 1.0,
) -> None:
    con = sqlite3.connect(db_path(data_dir))
    try:
        con.execute(
            """
            INSERT INTO presets(id, name, source_url, video_id, title, thumbnail_url, bpm, key_tonic, key_mode, semitones, master_volume, vocal_volume)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name=excluded.name,
              source_url=excluded.source_url,
              video_id=excluded.video_id,
              title=COALESCE(excluded.title, presets.title),
              thumbnail_url=COALESCE(excluded.thumbnail_url, presets.thumbnail_url),
              bpm=COALESCE(excluded.bpm, presets.bpm),
              key_tonic=COALESCE(excluded.key_tonic, presets.key_tonic),
              key_mode=COALESCE(excluded.key_mode, presets.key_mode),
              semitones=excluded.semitones,
              master_volume=excluded.master_volume,
              vocal_volume=excluded.vocal_volume,
              updated_at=strftime('%s','now');
            """
        , (id, name, source_url, video_id, title, thumbnail_url, bpm, key_tonic, key_mode, int(semitones), float(master_volume), float(vocal_volume)))
        con.commit()
    finally:
        con.close()


def delete_preset(data_dir: str, id: str) -> Optional[dict]:
    """Delete preset and return the deleted row (so callers can cascade cleanup)."""
    con = sqlite3.connect(db_path(data_dir))
    con.row_factory = sqlite3.Row
    try:
        row = con.execute("SELECT * FROM presets WHERE id=?", (id,)).fetchone()
        con.execute("DELETE FROM presets WHERE id=?", (id,))
        con.commit()
        return dict(row) if row else None
    finally:
        con.close()


def delete_track(data_dir: str, video_id: str) -> None:
    con = sqlite3.connect(db_path(data_dir))
    try:
        con.execute("DELETE FROM tracks WHERE video_id=?", (video_id,))
        con.commit()
    finally:
        con.close()


def get_preset_lyrics(data_dir: str, video_id: str) -> Optional[str]:
    """라이브러리 DB에서 가사 LRC 원문 조회 (video_id 기준)."""
    con = sqlite3.connect(db_path(data_dir))
    con.row_factory = sqlite3.Row
    try:
        row = con.execute(
            "SELECT lyrics_lrc FROM presets WHERE video_id=? AND lyrics_lrc IS NOT NULL",
            (video_id,),
        ).fetchone()
        return row["lyrics_lrc"] if row else None
    finally:
        con.close()


def set_preset_lyrics(data_dir: str, video_id: str, lrc_text: Optional[str]) -> int:
    """라이브러리 DB에 가사 LRC 원문 저장. 해당 video_id 프리셋 전체에 적용.

    프리셋이 아직 없으면(가져오기 전 스탬프 워크플로) 가사 전용 임시 프리셋을
    자동 생성 — 나중에 실제 곡이 로드되면 video_id로 묶여 함께 갱신됨.
    lrc_text=None 이면 아무것도 하지 않음 → 반환 0. 반환: 갱신된 행 수.
    """
    if lrc_text is None:
        return 0
    con = sqlite3.connect(db_path(data_dir))
    try:
        cur = con.execute(
            "UPDATE presets SET lyrics_lrc=?, updated_at=strftime('%s','now') WHERE video_id=?",
            (lrc_text, video_id),
        )
        if cur.rowcount == 0:
            con.execute(
                """
                INSERT INTO presets(id, name, video_id, lyrics_lrc)
                VALUES(?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET lyrics_lrc=excluded.lyrics_lrc,
                  updated_at=strftime('%s','now');
                """,
                (f"lyrics-{video_id}", video_id, video_id, lrc_text),
            )
            cur = con.execute(
                "UPDATE presets SET lyrics_lrc=? WHERE video_id=?",
                (lrc_text, video_id),
            )
        con.commit()
        return cur.rowcount
    finally:
        con.close()


def delete_preset_lyrics(data_dir: str, video_id: str) -> int:
    """해당 video_id의 모든 프리셋에서 가사 제거 (DB). 반환: 갱신 행 수.

    가사 전용 임시 프리셋(lyrics-<video_id>)은 실곡 로드 전 만들어진 것이라
    가사 삭제 시 함께 정리 (빈 껍데기가 라이브러리에 남지 않도록).
    """
    con = sqlite3.connect(db_path(data_dir))
    try:
        cur = con.execute(
            "UPDATE presets SET lyrics_lrc=NULL WHERE video_id=?", (video_id,)
        )
        con.execute("DELETE FROM presets WHERE id=?", (f"lyrics-{video_id}",))
        con.commit()
        return cur.rowcount
    finally:
        con.close()


def list_presets(data_dir: str, limit: int = 100) -> list[dict]:
    con = sqlite3.connect(db_path(data_dir))
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            "SELECT * FROM presets ORDER BY updated_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        con.close()
