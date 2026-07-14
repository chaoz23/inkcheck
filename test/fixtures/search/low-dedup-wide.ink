VAR depth = 0
VAR path_code = 0

-> branch

=== branch ===
{ depth >= 14:
    -> finish
}
~ depth += 1
+ [Left]
    ~ path_code = path_code * 3 + 1
    -> branch
+ [Center]
    ~ path_code = path_code * 3 + 2
    -> branch
+ [Right]
    ~ path_code = path_code * 3 + 3
    -> branch

=== finish ===
Wide tree leaf.
-> END
