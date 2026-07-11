=== market ===
{ gold < 5:
    Poor.
}
~ gold -= 3
~ health = health - RANDOM(1, 3)
{ TURNS() > 2:
    Late.
}
-> END
