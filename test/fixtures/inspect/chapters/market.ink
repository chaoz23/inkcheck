=== market ===
{ gold < 5:
    Poor.
}
~ gold -= 3
~ health = health - RANDOM(1, 3)
~ has_key = true
~ trust += 1
{ gold >= 10 && has_key && trust > 3:
    Vault.
}
{ TURNS() > 2:
    Late.
}
-> END
