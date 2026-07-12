# Future MCP adapter
MCP is deferred. Add an adapter that calls the same domain/application services used by the API for `generate_video`, `get_generation_status`, `list_user_videos`, `inspect_runtime`, and admin controls. It must reuse authentication context, authorization, credits, moderation, queue, runtime adapter, and audit logging rather than creating a second backend.
