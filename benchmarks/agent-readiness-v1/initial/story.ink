VAR gold = 1

-> shop

== finish
The bell rings as you leave.
-> END

== shop
You enter a quiet locksmith's shop.

* [Buy the brass key]
    ~ gold -= 2
    The key is yours.
* [Leave the shop]
    -> finish
