"""Example connector integration for Frappe LMS (Nusadaya Academy).

This file demonstrates how Frappe's doc_events hook can stream quiz answers
to getlearn.ai seamlessly and asynchronously without blocking user requests.

Usage in Frappe App (hooks.py):
-------------------------------
doc_events = {
    "LMS Quiz Result": {
        "on_submit": "nusadaya_academy.connectors.getlearn_connector.on_quiz_submitted"
    },
    "LMS Question": {
        "on_update": "nusadaya_academy.connectors.getlearn_connector.sync_question_objective"
    }
}
"""

import os
from getlearn import GetLearnClient

# Initialize client using environment variables configured in site_config.json
GETLEARN_API_KEY = os.getenv("GETLEARN_API_KEY", "dev-nusadaya-key")
GETLEARN_BASE_URL = os.getenv("GETLEARN_BASE_URL", "https://getlearn-core-production.up.railway.app")

client = GetLearnClient(
    api_key=GETLEARN_API_KEY,
    base_url=GETLEARN_BASE_URL,
)

def on_quiz_submitted(doc, method=None):
    """Hook triggered on submit of 'LMS Quiz Result'.
    
    doc: Frappe document instance representing 'LMS Quiz Result'
    Fields expected:
      - doc.name: unique ID of the quiz attempt
      - doc.user: learner email or opaque user docname
      - doc.question: LMS Question ID
      - doc.is_correct: boolean or 1/0
      - doc.user_response: submitted text / option
      - doc.creation / doc.modified: timestamp
    """
    # Important: In accordance with privacy rules, avoid sending raw email if docname exists
    external_learner_id = doc.user # Or frappe.db.get_value("User", doc.user, "name")

    # Enqueue asynchronously in Frappe background queue so it never slows down student submit
    # frappe.enqueue(
    #     _send_quiz_event,
    #     queue="short",
    #     event_id=f"frappe_qz_{doc.name}",
    #     learner_id=external_learner_id,
    #     item_id=doc.question,
    #     is_correct=bool(doc.is_correct),
    #     raw_response=str(doc.user_response or ""),
    # )

    return _send_quiz_event(
        event_id=f"frappe_qz_{doc.name}",
        learner_id=external_learner_id,
        item_id=doc.question,
        is_correct=bool(doc.is_correct),
        raw_response=str(doc.user_response or ""),
    )

def _send_quiz_event(event_id, learner_id, item_id, is_correct, raw_response):
    """Worker function sending event to getlearn.ai."""
    try:
        res = client.send_event(
            event_id=event_id,
            external_learner_id=learner_id,
            item_id=item_id,
            is_correct=is_correct,
            raw_response=raw_response,
        )
        return res
    except Exception as e:
        # In Frappe: frappe.log_error(title="getlearn ingestion failed", message=str(e))
        print(f"Failed to ingest event {event_id}: {e}")
        raise

def get_learner_study_card(user_docname):
    """Helper for LMS frontend to query next recommended learning action."""
    try:
        next_action = client.get_next_action(learner_id=user_docname)
        gaps = client.get_gaps(learner_id=user_docname)
        return {
            "action": next_action.action,
            "target_id": next_action.target_id,
            "explanation": next_action.explanation,
            "has_gaps": len(gaps) > 0,
            "gaps_count": len(gaps),
        }
    except Exception as e:
        return None
