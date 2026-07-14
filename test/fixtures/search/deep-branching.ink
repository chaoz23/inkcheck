VAR depth = 0
VAR witness_prefix = ""

-> branch

=== branch ===
{ depth >= 100:
    -> finish
}
~ depth += 1
+ [Left]
    ~ witness_prefix = witness_prefix + "L"
    -> branch
+ [Right]
    ~ witness_prefix = witness_prefix + "R"
    -> branch

=== finish ===
Deep tree leaf.
-> END
