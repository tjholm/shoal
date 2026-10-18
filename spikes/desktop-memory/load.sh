#!/usr/bin/env bash
# Streams the same chat request through the server, back to back, until killed.
# Uses SHOAL_SERVER, SHOAL_KEY_FILE, EXTRA_CA and MODEL, as connected.sh does.
sleep 15
while true; do
	curl -sS -N ${EXTRA_CA:+--cacert "$EXTRA_CA"} "$SHOAL_SERVER/api/v1/chat/completions" \
		-H "Authorization: Bearer $(cat "$SHOAL_KEY_FILE")" -H 'content-type: application/json' \
		-d "{\"model\":\"$MODEL\",\"stream\":true,\"max_tokens\":300,\"messages\":[{\"role\":\"user\",\"content\":\"Write a short story about a lighthouse keeper.\"}]}" >/dev/null
done
