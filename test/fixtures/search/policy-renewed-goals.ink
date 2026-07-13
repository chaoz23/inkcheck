VAR progress = 0

-> advance

=== advance ===
{ progress >= 40:
    -> done
- else:
    + [Advance]
        ~ progress = progress + 1
        -> advance
}

=== done ===
Complete.
-> END
