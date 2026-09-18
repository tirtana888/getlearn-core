from dataclasses import dataclass
from typing import Optional, List, Dict, Any

@dataclass
class LearningObjective:
    id: str
    label: str
    tenant_id: str
    parent_id: Optional[str] = None

@dataclass
class ContentItem:
    id: str
    type: str
    objective_ids: List[str]
    tenant_id: str
    source_uri: Optional[str] = None

@dataclass
class AssessmentItem:
    id: str
    item_type: str
    prompt_text: str
    objective_ids: List[str]
    tenant_id: str

@dataclass
class EventIngestionResult:
    status: str
    event_id: str
    mastery_updated: bool

@dataclass
class MasteryScore:
    objective_id: str
    label: str
    score: float
    evidence_count: int
    confidence: str
    is_gap: bool
    updated_at: str

@dataclass
class Recommendation:
    learner_id: str
    action: str
    target_id: str
    reason_objective_id: str
    explanation: str
