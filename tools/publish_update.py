#!/usr/bin/env python3
"""Drive 제자리 배포 — update zip + manifest를 files.update로 갱신 (파일 ID 불변).

최초 1회: zip/manifest가 신규 업로드되고 anyone-reader 권한이 부여된다.
  출력된 파일 ID를 이후 실행 때 --zip-id/--manifest-id(또는 환경변수)로 넘겨주면
  이후 배포는 내용만 제자리 갱신 → 링크·ID 영구 유지 (앱에 박힌 manifest URL도 영구 유효).

사용: python3 tools/publish_update.py --notes "요약" [--zip-id FID] [--manifest-id FID]
필요: ~/.hermes/google_token.json (google-workspace OAuth) + googleapiclient
"""
import argparse
import glob
import importlib.util
import json
import os
import sys

GAPI_PATH = os.path.expanduser(
    "~/.hermes/skills/productivity/google-workspace/scripts/google_api.py"
)
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_gapi():
    spec = importlib.util.spec_from_file_location("gapi", GAPI_PATH)
    assert spec and spec.loader, "google_api.py 로드 실패"
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--notes", default="")
    ap.add_argument("--zip-id", default=os.environ.get("DRIVE_ZIP_FILE_ID", ""))
    ap.add_argument("--manifest-id", default=os.environ.get("DRIVE_MANIFEST_FILE_ID", ""))
    a = ap.parse_args()

    zips = sorted(glob.glob(os.path.join(REPO, "dist", "update-v*.zip")))
    if not zips:
        sys.exit("dist/update-v*.zip 없음 — 먼저 ./build_update_zip.sh 실행")
    zip_path = zips[-1]
    manifest_path = os.path.join(REPO, "dist", "update-manifest.json")
    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)
    manifest["notes"] = a.notes

    gapi = load_gapi()
    from googleapiclient.http import MediaFileUpload

    svc = gapi.build_service("drive", "v3")

    def put(fid, path, mime, name):
        media = MediaFileUpload(path, mimetype=mime)
        if fid:
            svc.files().update(fileId=fid, media_body=media).execute()
            return fid
        res = (
            svc.files()
            .create(body={"name": name}, media_body=media, fields="id")
            .execute()
        )
        new_id = res["id"]
        svc.permissions().create(
            fileId=new_id, body={"type": "anyone", "role": "reader"}
        ).execute()
        return new_id

    zip_fid = put(a.zip_id, zip_path, "application/zip", "pm-update-code.zip")
    manifest["zip_file_id"] = zip_fid
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    man_fid = put(a.manifest_id, manifest_path, "application/json", "pm-update-manifest.json")

    print(
        json.dumps(
            {
                "version": manifest.get("version"),
                "zip_file_id": zip_fid,
                "manifest_file_id": man_fid,
                "manifest_url": "https://drive.usercontent.google.com/download?id=%s&export=download&confirm=t" % man_fid,
                "zip_url": "https://drive.usercontent.google.com/download?id=%s&export=download&confirm=t" % zip_fid,
            },
            indent=1,
        )
    )
    if not a.manifest_id:
        print("\n⚠ 최초 배포: 위 manifest_file_id를 updater.py 기본 URL에 박은 뒤 재빌드·재배포하세요.")


if __name__ == "__main__":
    main()
