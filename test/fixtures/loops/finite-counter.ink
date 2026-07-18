VAR laps = 0
-> hub

== hub
+ {laps < 3} [Walk one lap]
    ~ laps += 1
    -> hub
+ [Leave]
    -> END
