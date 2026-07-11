VAR gold = 1
VAR health = 5
VAR max_health = 10
VAR ready = false
VAR key = false

Choose a test path.

* [Spend too much gold]
    ~ gold = gold - 2
    -> bad_resource
* [Exceed maximum health]
    ~ health = 11
    -> bad_resource
* [Finish before preparation]
    -> unprepared_end
* [Enter the locked gate]
    -> locked_gate
* [Take the valid path]
    ~ ready = true
    ~ key = true
    -> valid_end

== bad_resource
Resource path.
-> END

== unprepared_end
Unprepared ending.
-> END

== locked_gate
Locked gate.
-> END

== valid_end
Valid ending.
-> END
