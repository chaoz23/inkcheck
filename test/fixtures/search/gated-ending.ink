VAR has_key = false
-> start

== start
Choose.

+ {not has_key} [Search the desk]
    ~ has_key = true
    -> start
+ {has_key} [Open the gate]
    -> escaped
+ [Leave]
    -> stayed

== escaped
The gate opens.
-> END

== stayed
The gate stays closed.
-> END
