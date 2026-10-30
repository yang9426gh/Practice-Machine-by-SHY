"""import_library_items 병합 로직 유닛테스트 — 임시 DB 사용 (실 라이브러리 무손상)."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from db import init_db, import_library_items, get_preset  # noqa: E402

tmp = tempfile.mkdtemp(prefix="pmd_test_")
init_db(tmp)
passed, failed = [], []


def check(name, cond, detail=""):
    (passed if cond else failed).append(name)
    print(("PASS" if cond else "FAIL") + f"  {name}" + (f"  [{detail}]" if detail and not cond else ""))


# 1. 신규 생성
r = import_library_items(tmp, [{
    "video_id": "abc12345678", "url": "https://www.youtube.com/watch?v=abc12345678",
    "title": "테스트 곡", "thumbnail_url": "https://i.ytimg.com/vi/abc12345678/mqdefault.jpg",
    "bpm": 72.5, "key_tonic": "C", "key_mode": "major",
    "lyrics_lrc": "[00:01.00] 한", "chords_lrc": "[00:01.00] C",
}])
p = get_preset(tmp, "abc12345678")
check("1. 신규 created", r[0]["action"] == "created", str(r))
check("1. 필드 저장", p and p["bpm"] == 72.5 and p["key_tonic"] == "C" and p["lyrics_lrc"] == "[00:01.00] 한")

# 2. 멱등 — 동일 파일 재import → unchanged, 값 불변
r = import_library_items(tmp, [{
    "video_id": "abc12345678", "title": "테스트 곡", "bpm": 72.5,
    "lyrics_lrc": "[00:01.00] 한", "chords_lrc": "[00:01.00] C",
}])
p = get_preset(tmp, "abc12345678")
check("2. 재import unchanged", r[0]["action"] == "unchanged", str(r))
check("2. lyrics 불변", p["lyrics_lrc"] == "[00:01.00] 한")

# 3. 기존 값 절대 미덮음 — bpm 다르게 와도 유지
r = import_library_items(tmp, [{
    "video_id": "abc12345678", "title": "다른제목", "bpm": 90, "key_tonic": "G",
    "lyrics_lrc": "[00:01.00] 다른가사", "chords_lrc": "[00:01.00] Am",
}])
p = get_preset(tmp, "abc12345678")
check("3. unchanged (전부 비어있지 않으면)", r[0]["action"] == "unchanged", str(r))
check("3. bpm/제목/가사 보존", p["bpm"] == 72.5 and p["title"] == "테스트 곡" and p["lyrics_lrc"] == "[00:01.00] 한")

# 4. 빈 필드만 채움 — 코드가 비어있는 곡에 코드만 보충
import_library_items(tmp, [{"video_id": "empty0000001", "title": "빈곡", "bpm": 100}])
r = import_library_items(tmp, [{"video_id": "empty0000001", "chords_lrc": "[00:00.00] G", "key_tonic": "D"}])
p = get_preset(tmp, "empty0000001")
check("4. updated (보충)", r[0]["action"] == "updated" and set(r[0]["filled"]) == {"Key", "코드"}, str(r))
check("4. bpm 보존 + 코드 채움", p["bpm"] == 100 and p["chords_lrc"] == "[00:00.00] G" and p["key_tonic"] == "D")

# 5. 파일 내 중복 video_id — 순차 처리로 통합 (첫 항목 우선 + 빈 필드 보충)
r = import_library_items(tmp, [
    {"video_id": "dup000000001", "title": "중복곡", "lyrics_lrc": "[00:00.00] 가사"},
    {"video_id": "dup000000001", "bpm": 88, "chords_lrc": "[00:00.00] Em"},
])
p = get_preset(tmp, "dup000000001")
check("5. 중복 통합(1 created, 1 updated)", [x["action"] for x in r] == ["created", "updated"], str(r))
check("5. union 저장", p["title"] == "중복곡" and p["bpm"] == 88 and p["chords_lrc"] == "[00:00.00] Em")

# 6. 무효 항목 — video_id 없음 → skipped (크래시 없음)
r = import_library_items(tmp, [{"title": "vid없음"}, {"video_id": "", "bpm": 1}])
check("6. skipped 2건", all(x["action"] == "skipped" for x in r) and len(r) == 2, str(r))

# 7. key_mode 정규화 — 대문자/major·minor 외 값 → None
r = import_library_items(tmp, [{"video_id": "mode00000001", "key_tonic": "c", "key_mode": "MAJOR"}])
p = get_preset(tmp, "mode00000001")
check("7. key_mode 소문자 정규화", p["key_mode"] == "major", str(p["key_mode"]))
r = import_library_items(tmp, [{"video_id": "mode00000002", "key_mode": "dorian"}])
p = get_preset(tmp, "mode00000002")
check("7. 이상 key_mode → None", p["key_mode"] is None)

# 8. 셸 프리셋(lyrics-<vid>) 공존 — 셸 가사 보존 + 셸 행에 보충
import sqlite3
con = sqlite3.connect(os.path.join(tmp, "index.db"))
con.execute("INSERT INTO presets(id, name, video_id, lyrics_lrc) VALUES(?,?,?,?)",
            ("lyrics-shell000001", "셸", "shell000001", "[00:00.00] 셸가사"))
con.commit(); con.close()
r = import_library_items(tmp, [{"video_id": "shell000001", "bpm": 60, "chords_lrc": "[00:00.00] C"}])
con = sqlite3.connect(os.path.join(tmp, "index.db"))
row = con.execute("SELECT bpm, lyrics_lrc, chords_lrc FROM presets WHERE video_id='shell000001'").fetchone()
con.close()
check("8. 셸 행 updated + 가사 보존", r[0]["action"] == "updated" and row == (60.0, "[00:00.00] 셸가사", "[00:00.00] C"), str(row))

# 9. 새 프리셋은 id=video_id (다운로드 시 upsert_preset 병합 대상)
check("9. id=video_id 체계", get_preset(tmp, "abc12345678")["video_id"] == "abc12345678")

print(f"\n=== {len(passed)} passed, {len(failed)} failed ===")
sys.exit(1 if failed else 0)
