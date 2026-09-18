import json
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

from .exceptions import (
    GetLearnError,
    AuthenticationError,
    NotFoundError,
    ValidationError,
    APIError,
)
from .models import (
    LearningObjective,
    ContentItem,
    AssessmentItem,
    EventIngestionResult,
    MasteryScore,
    Recommendation,
)

DEFAULT_BASE_URL = "https://getlearn-core-production.up.railway.app"

class GetLearnClient:
    """Official Python Client for getlearn.ai API."""

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: int = 15,
        max_retries: int = 3,
    ):
        self.api_key = api_key.strip()
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries

    def _request(
        self,
        method: str,
        path: str,
        payload: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        if params:
            query_str = "&".join(f"{k}={v}" for k, v in params.items() if v is not None)
            if query_str:
                url = f"{url}?{query_str}"

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "User-Agent": "getlearn-python-sdk/0.1.0",
        }

        data = json.dumps(payload).encode("utf-8") if payload is not None else None

        last_error = None
        for attempt in range(self.max_retries):
            try:
                req = Request(url, data=data, headers=headers, method=method)
                with urlopen(req, timeout=self.timeout) as response:
                    raw_body = response.read().decode("utf-8")
                    if raw_body:
                        return json.loads(raw_body)
                    return {}
            except HTTPError as e:
                err_body = e.read().decode("utf-8")
                parsed_err = {}
                try:
                    parsed_err = json.loads(err_body).get("error", {})
                except Exception:
                    pass

                msg = parsed_err.get("message", e.reason)
                code = parsed_err.get("code", "")

                if e.code == 401:
                    raise AuthenticationError(msg)
                elif e.code == 404:
                    raise NotFoundError(msg)
                elif e.code == 400:
                    raise ValidationError(msg, parsed_err.get("details"))
                elif e.code >= 500:
                    last_error = APIError(e.code, msg)
                    time.sleep(0.5 * (2 ** attempt))
                    continue
                else:
                    raise APIError(e.code, msg)
            except URLError as e:
                last_error = GetLearnError(f"Network connection failed: {e.reason}")
                time.sleep(0.5 * (2 ** attempt))
                continue

        if last_error:
            raise last_error
        raise GetLearnError("Request failed after maximum retries")

    # =========================================================================
    # Registration Endpoints
    # =========================================================================

    def register_objective(
        self,
        id: str,
        label: str,
        parent_id: Optional[str] = None,
    ) -> LearningObjective:
        """Register or update a learning objective."""
        data = self._request(
            "POST",
            "/v1/objectives",
            payload={"id": id, "label": label, "parent_id": parent_id},
        )
        return LearningObjective(
            id=data["id"],
            label=data["label"],
            tenant_id=data.get("tenant_id", ""),
            parent_id=data.get("parent_id"),
        )

    def register_content_item(
        self,
        id: str,
        type: str,
        objective_ids: List[str],
        source_uri: Optional[str] = None,
        raw_text: Optional[str] = None,
    ) -> ContentItem:
        """Register or update instructional content (text, video, pdf, scorm)."""
        data = self._request(
            "POST",
            "/v1/content-items",
            payload={
                "id": id,
                "type": type,
                "objective_ids": objective_ids,
                "source_uri": source_uri,
                "raw_text": raw_text,
            },
        )
        return ContentItem(
            id=data["id"],
            type=data["type"],
            objective_ids=data.get("objective_ids", []),
            tenant_id=data.get("tenant_id", ""),
            source_uri=data.get("source_uri"),
        )

    def search_content(
        self,
        query: str,
        limit: int = 5,
    ) -> List[Dict[str, Any]]:
        """Semantic search over instructional content chunks using pgvector."""
        data = self._request(
            "POST",
            "/v1/content-items/search",
            payload={"query": query, "limit": limit},
        )
        return data.get("results", [])

    def register_assessment_item(
        self,
        id: str,
        prompt_text: str,
        item_type: str = "mcq",
        objective_ids: Optional[List[str]] = None,
    ) -> AssessmentItem:
        """Register or update a quiz/test assessment question."""
        data = self._request(
            "POST",
            "/v1/assessment-items",
            payload={
                "id": id,
                "prompt_text": prompt_text,
                "item_type": item_type,
                "objective_ids": objective_ids or [],
            },
        )
        return AssessmentItem(
            id=data["id"],
            item_type=data["item_type"],
            prompt_text=data["prompt_text"],
            objective_ids=data.get("objective_ids", []),
            tenant_id=data.get("tenant_id", ""),
        )

    # =========================================================================
    # Event Ingestion
    # =========================================================================

    def send_event(
        self,
        event_id: str,
        external_learner_id: str,
        item_id: str,
        is_correct: bool,
        raw_response: Optional[str] = None,
        event_type: str = "assessment.answered",
        occurred_at: Optional[str] = None,
    ) -> EventIngestionResult:
        """Send an assessment event to getlearn.ai. Idempotent based on event_id."""
        if not occurred_at:
            occurred_at = datetime.now(timezone.utc).isoformat()

        data = self._request(
            "POST",
            "/v1/events",
            payload={
                "event_id": event_id,
                "event_type": event_type,
                "external_learner_id": external_learner_id,
                "occurred_at": occurred_at,
                "payload": {
                    "item_id": item_id,
                    "is_correct": is_correct,
                    "raw_response": raw_response,
                },
            },
        )
        return EventIngestionResult(
            status=data.get("status", "processed"),
            event_id=data.get("event_id", event_id),
            mastery_updated=data.get("mastery_updated", False),
        )

    # =========================================================================
    # Learner Intelligence Queries
    # =========================================================================

    def get_mastery(self, learner_id: str) -> List[MasteryScore]:
        """Fetch current mastery scores across all objectives for a learner."""
        data = self._request("GET", f"/v1/learners/{learner_id}/mastery")
        items = data.get("mastery", [])
        return [
            MasteryScore(
                objective_id=item["objective_id"],
                label=item.get("label", ""),
                score=float(item["score"]),
                evidence_count=item.get("evidence_count", 0),
                confidence=item.get("confidence", "low"),
                is_gap=item.get("is_gap", False),
                updated_at=item.get("updated_at", ""),
            )
            for item in items
        ]

    def get_gaps(self, learner_id: str, threshold: float = 0.70) -> List[MasteryScore]:
        """Fetch learning objectives where mastery is below the threshold."""
        data = self._request(
            "GET",
            f"/v1/learners/{learner_id}/gaps",
            params={"threshold": threshold},
        )
        items = data.get("gaps", [])
        return [
            MasteryScore(
                objective_id=item["objective_id"],
                label=item.get("label", ""),
                score=float(item["score"]),
                evidence_count=item.get("evidence_count", 0),
                confidence=item.get("confidence", "low"),
                is_gap=True,
                updated_at=item.get("updated_at", ""),
            )
            for item in items
        ]

    def get_next_action(self, learner_id: str) -> Recommendation:
        """Fetch the prioritized next-best learning action for a learner."""
        data = self._request("GET", f"/v1/learners/{learner_id}/next-action")
        return Recommendation(
            learner_id=data.get("learner_id", learner_id),
            action=data["action"],
            target_id=data["target_id"],
            reason_objective_id=data["reason_objective_id"],
            explanation=data["explanation"],
        )
