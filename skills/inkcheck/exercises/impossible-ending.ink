VAR opened = false
{ opened:
    -> secret_ending
- else:
    -> ordinary_ending
}

=== secret_ending ===
The sealed room opens.
-> END

=== ordinary_ending ===
You leave.
-> END
