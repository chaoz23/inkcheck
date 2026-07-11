VAR insight = 0
VAR trust = 0
VAR day = 0

-> hub

=== hub ===
~ day += 1
{ day > 8:
    -> timeout
}
+ {insight < 3} [Research]
    ~ insight += 1
    -> hub
+ {trust < 3} [Talk]
    ~ trust += 1
    -> hub
+ {insight >= 2 && trust >= 2} [Attempt]
    -> proof
+ [Wait]
    -> hub

=== proof ===
{ insight >= 3 && trust >= 3:
    -> success
- else:
    -> failure
}

=== success ===
The proof holds.
-> END

=== failure ===
The proof collapses.
-> END

=== timeout ===
Time runs out.
-> END
