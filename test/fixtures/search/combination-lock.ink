VAR a = 0
VAR b = 0
VAR c = 0
VAR success = false

-> a_choice

=== a_choice ===
* [One]
    ~ a = 1
    -> b_choice
* [Two]
    ~ a = 2
    -> b_choice
* [Three]
    ~ a = 3
    -> b_choice

=== b_choice ===
* [One]
    ~ b = 1
    -> c_choice
* [Two]
    ~ b = 2
    -> c_choice
* [Three]
    ~ b = 3
    -> c_choice

=== c_choice ===
* [One]
    ~ c = 1
    -> check
* [Two]
    ~ c = 2
    -> check
* [Three]
    ~ c = 3
    -> check

=== check ===
{ a == 3 && b == 1 && c == 2:
    -> vault
- else:
    -> locked
}

=== vault ===
~ success = true
Vault opened.
-> END

=== locked ===
Still locked.
-> END
