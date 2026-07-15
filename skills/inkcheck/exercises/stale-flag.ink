VAR carrying = false
* [Take the parcel]
    ~ carrying = true
    -> return_home
* [Go home]
    -> return_home

=== return_home ===
{ carrying:
    You still have the parcel.
- else:
    You arrive empty-handed.
}
-> END
