VAR origin = 0
VAR role = 0

-> origin_choice

=== origin_choice ===
* [North]
    ~ origin = 1
    -> role_choice
* [South]
    ~ origin = 2
    -> role_choice
* [West]
    ~ origin = 3
    -> role_choice

=== role_choice ===
* [Scout]
    ~ role = 1
    -> corridor_1
* [Scholar]
    ~ role = 2
    -> corridor_1
* [Smith]
    ~ role = 3
    -> corridor_1

=== corridor_1 ===
* [Left] -> corridor_2
* [Center] -> corridor_2
* [Right] -> corridor_2

=== corridor_2 ===
* [Left] -> finish
* [Center] -> finish
* [Right] -> finish

=== finish ===
{ origin == 1 && role == 1:
    -> north_scout
- else:
    { origin == 2 && role == 2:
        -> south_scholar
    - else:
        { origin == 3 && role == 3:
            -> west_smith
        - else:
            -> ordinary
        }
    }
}

=== north_scout ===
North scout ending.
-> END

=== south_scholar ===
South scholar ending.
-> END

=== west_smith ===
West smith ending.
-> END

=== ordinary ===
Ordinary ending.
-> END
