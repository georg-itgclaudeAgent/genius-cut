"""The one error type every AI provider raises. Lives here so the providers, the spend
gate and the `llm` façade can all share it without importing each other."""


class LLMError(RuntimeError):
    pass
