UPDATE sessions
SET ownership_epoch = ?
WHERE session_key = ?
  AND ownership_epoch = ?;
