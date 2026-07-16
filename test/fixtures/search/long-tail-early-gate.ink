VAR origin = 0
VAR depth = 0
VAR path_code = 0

-> origin_choice

=== origin_choice ===
* [North]
    ~ origin = 1
    -> branch
* [South]
    ~ origin = 2
    -> branch
* [West]
    ~ origin = 3
    -> branch

=== branch ===
{ depth >= 8:
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
{ origin == 1:
    -> north_end
- else:
    { origin == 2:
        -> south_end
    - else:
        -> west_failure
    }
}

=== north_end ===
North ending.
-> END

=== south_end ===
South ending.
-> END

=== west_failure ===
The west gate opens onto unfinished content.
