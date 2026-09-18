import os
import sys
import time

# Add sdk/python to path for running locally without pip install
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from getlearn import GetLearnClient

def main():
    print(">>> Testing getlearn Python SDK against live Railway API...\n")
    
    base_url = "https://getlearn-core-production.up.railway.app"
    api_key = "dev-nusadaya-key"
    client = GetLearnClient(api_key=api_key, base_url=base_url)

    # 1. Register Objective
    print("[1] Registering Learning Objective...")
    obj = client.register_objective(
        id="obj_py_geom_01",
        label="Geometri: Menghitung Keliling dan Luas Lingkaran",
    )
    print(f"    [OK] Registered objective: {obj.id} - {obj.label}")
    assert obj.id == "obj_py_geom_01"

    # 2. Register Content Item
    print("[2] Registering Content Item...")
    content = client.register_content_item(
        id="lesson_circle_01",
        type="video",
        objective_ids=["obj_py_geom_01"],
        source_uri="https://www.youtube.com/watch?v=example",
    )
    print(f"    [OK] Registered content: {content.id} (type: {content.type})")
    assert content.id == "lesson_circle_01"

    # 3. Register Assessment Item
    print("[3] Registering Assessment Item...")
    item = client.register_assessment_item(
        id="q_circle_area_01",
        prompt_text="Berapa luas lingkaran dengan jari-jari r = 7 cm? (pi = 22/7)",
        item_type="mcq",
        objective_ids=["obj_py_geom_01"],
    )
    print(f"    [OK] Registered assessment question: {item.id}")
    assert item.id == "q_circle_area_01"

    # 4. Ingest Event 1: Correct Answer
    learner_id = f"usr_py_learner_{int(time.time())}"
    event1_id = f"evt_py_{int(time.time())}_1"
    print(f"[4] Ingesting 1st Assessment Event (Correct) for {learner_id}...")
    res1 = client.send_event(
        event_id=event1_id,
        external_learner_id=learner_id,
        item_id="q_circle_area_01",
        is_correct=True,
        raw_response="154 cm2",
    )
    print(f"    [OK] Ingested: status={res1.status}, mastery_updated={res1.mastery_updated}")
    assert res1.status == "processed"

    # 5. Check Mastery
    print("[5] Verifying Mastery...")
    mastery = client.get_mastery(learner_id=learner_id)
    print(f"    [OK] Mastery records: {len(mastery)}")
    assert len(mastery) == 1
    assert mastery[0].score == 1.0

    # 6. Ingest Event 2: Incorrect Answer
    event2_id = f"evt_py_{int(time.time())}_2"
    print("[6] Ingesting 2nd Assessment Event (Incorrect)...")
    res2 = client.send_event(
        event_id=event2_id,
        external_learner_id=learner_id,
        item_id="q_circle_area_01",
        is_correct=False,
        raw_response="44 cm2",
    )
    print(f"    [OK] Ingested: status={res2.status}")
    assert res2.status == "processed"

    # 7. Check Gaps (score 0.5 < 0.70)
    print("[7] Checking Gaps...")
    gaps = client.get_gaps(learner_id=learner_id, threshold=0.70)
    print(f"    [OK] Found {len(gaps)} gap(s): score={gaps[0].score}")
    assert len(gaps) == 1
    assert gaps[0].score == 0.5

    # 8. Check Next Action
    print("[8] Checking Next Action...")
    next_action = client.get_next_action(learner_id=learner_id)
    print(f"    [OK] Action: {next_action.action} on target: {next_action.target_id}")
    print(f"    [INFO] Explanation: {next_action.explanation}")
    assert next_action.action == "review"
    assert next_action.target_id == "lesson_circle_01"

    # 9. Idempotency Check
    print("[9] Testing Idempotency (re-sending event 2)...")
    dup_res = client.send_event(
        event_id=event2_id,
        external_learner_id=learner_id,
        item_id="q_circle_area_01",
        is_correct=False,
        raw_response="44 cm2",
    )
    print(f"    [OK] Re-sent event status: {dup_res.status}")
    assert dup_res.status == "duplicate_ignored"

    # 10. AI Study Coach Chat Session
    print("[10] Testing AI Study Coach Chat Engine...")
    session = client.start_chat_session(
        learner_id=learner_id,
        scope="objective",
        objective_ids=["obj_py_geom_01"],
    )
    session_id = session["session_id"]
    print(f"    [OK] Chat session started: {session_id}")
    print(f"    [OPENING] {session['opening_message'][:90]}...")
    assert "session_id" in session

    # 11. Send Question with Voice
    print("[11] Sending Learner Question (with voice=True)...")
    chat_reply = client.send_chat_message(
        session_id=session_id,
        message="Bagaimana rumus menghitung luas lingkaran?",
        is_assessment_active=False,
        voice=True,
    )
    print(f"    [REPLY] {chat_reply['content'][:100]}...")
    if chat_reply.get("audio_url"):
        print(f"    [VOICE] Audio stream available: {chat_reply['audio_url'][:40]}...")
    assert chat_reply["sender"] == "assistant"

    # 12. Send Active Assessment Question (Socratic Guardrail)
    print("[12] Testing Socratic Guardrail during active assessment...")
    socratic_reply = client.send_chat_message(
        session_id=session_id,
        message="Berapa jawaban langsung untuk soal jari-jari 7 cm?",
        is_assessment_active=True,
    )
    print(f"    [SOCRATIC] {socratic_reply['content'][:100]}...")
    assert socratic_reply["sender"] == "assistant"

    print("\n>>> ALL PYTHON SDK LIVE TESTS PASSED SUCCESSFULLY! <<<\n")

if __name__ == "__main__":
    main()
