VAR key = false

-> key_choice

=== key_choice ===
* [Take the plain key]
    ~ key = true
    -> hall_1
* [Take the bright key]
    -> hall_1

=== hall_1 ===
* [Left] -> hall_2
* [Right] -> hall_2

=== hall_2 ===
* [Left] -> hall_3
* [Right] -> hall_3

=== hall_3 ===
* [Left] -> door
* [Right] -> door

=== door ===
{ key:
    -> hidden_error
- else:
    -> ordinary_end
}

=== hidden_error ===
The hidden chamber opens.

=== ordinary_end ===
You leave.
-> END
