class GetLearnError(Exception):
    """Base exception for all getlearn SDK errors."""
    pass

class AuthenticationError(GetLearnError):
    """Raised when the API key is missing, invalid, or unauthorized."""
    pass

class NotFoundError(GetLearnError):
    """Raised when a requested resource (learner, objective, etc.) is not found."""
    pass

class ValidationError(GetLearnError):
    """Raised when request payload fails validation."""
    def __init__(self, message: str, details: list = None):
        super().__init__(message)
        self.details = details or []

class APIError(GetLearnError):
    """Raised when the getlearn API returns a 5xx or unhandled status code."""
    def __init__(self, status_code: int, message: str):
        super().__init__(f"HTTP {status_code}: {message}")
        self.status_code = status_code
