# getlearn Python SDK

Official lightweight Python client for **getlearn.ai** — standalone Learner Intelligence Infrastructure.

Designed with **zero external dependencies** (uses standard library `urllib`), making it completely safe and conflict-free for Frappe LMS (`nusadaya_academy`), Django, FastAPI, or any Python backend.

---

## 📦 Instalasi

### Dari direktori lokal atau repositori git:
```bash
pip install git+https://github.com/tirtana888/getlearn-core.git#subdirectory=sdk/python
```
atau salin folder `getlearn/` langsung ke aplikasi Frappe Anda.

---

## 🚀 Penggunaan Dasar

```python
from getlearn import GetLearnClient

client = GetLearnClient(
    api_key="your_tenant_api_key",
    base_url="https://getlearn-core-production.up.railway.app", # atau url backend Anda
)

# 1. Daftarkan Learning Objective (Kompetensi)
client.register_objective(
    id="obj_algebra_01",
    label="Persamaan Linier Satu Variabel",
)

# 2. Daftarkan Materi Belajar (Content Item)
client.register_content_item(
    id="lesson_alg_intro",
    type="text", # text | video | pdf | scorm
    objective_ids=["obj_algebra_01"],
    source_uri="https://nusadaya.academy/courses/math/lesson-1",
)

# 3. Daftarkan Soal Asesmen (Assessment Item)
client.register_assessment_item(
    id="q_alg_101",
    prompt_text="Tentukan nilai x jika 2x + 4 = 10",
    item_type="mcq",
    objective_ids=["obj_algebra_01"],
)

# 4. Laporkan Jawaban Siswa (Idempotent via event_id)
res = client.send_event(
    event_id="evt_quiz_submit_99182",
    external_learner_id="usr_lms_881", # Opaque ID siswa di LMS (tanpa PII)
    item_id="q_alg_101",
    is_correct=True,
    raw_response="x = 3",
)
print(res.status) # "processed" atau "duplicate_ignored"

# 5. Ambil Penguasaan Materi (Mastery)
mastery_list = client.get_mastery(learner_id="usr_lms_881")
for m in mastery_list:
    print(f"{m.label}: {m.score * 100:.0f}% (Bukti: {m.evidence_count})")

# 6. Ambil Rekomendasi Tindakan Berikutnya (Next Best Action)
action = client.get_next_action(learner_id="usr_lms_881")
print(f"Rekomendasi: {action.action} pada {action.target_id}")
print(f"Alasan: {action.explanation}")
```

---

## 🔌 Integrasi Frappe LMS (Nusadaya Academy)

Lihat contoh lengkap pada file [`examples/frappe_lms_connector.py`](./examples/frappe_lms_connector.py).

Di `hooks.py` Frappe app Anda:
```python
doc_events = {
    "LMS Quiz Result": {
        "on_submit": "nusadaya_academy.connectors.getlearn_connector.on_quiz_submitted"
    }
}
```
Event dikirimkan secara otomatis setiap kali siswa menyelesaikan kuis, memperbarui skor *mastery* secara *real-time*.
