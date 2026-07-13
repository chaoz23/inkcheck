VAR steps = 0
-> start

== start
Choose.

+ [Advance]
    ~ steps += 1
    { steps >= 3:
        -> finished
    - else:
        -> start
    }
+ [Stop early]
    -> stopped

== finished
The counter completed.
-> END

== stopped
The counter stopped at {steps}.
-> END
