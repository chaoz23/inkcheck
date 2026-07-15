VAR waited = false
* [Wait]
    ~ waited = true
    -> check_time
* [Act now]
    -> check_time

=== check_time ===
{ TURNS() > 0 && waited:
    Time passed.
- else:
    No time passed.
}
-> END
