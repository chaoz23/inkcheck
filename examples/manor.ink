VAR torches = 0
VAR gold = 0
-> entrance

=== entrance ===
The manor door creaks open before you touch it.
* [Take the torch from the sconce]
    ~ torches = 1
    You lift the torch. Shadows retreat.
    -> hallway
* [Enter in darkness] -> hallway

=== hallway ===
{torches == 0: You stumble through the black hallway.|Torchlight ripples over portraits.}
* [Search the study] -> study
* [Descend to the cellar] -> cellar

=== study ===
~ gold = gold + 50
You pocket {gold} coins from the desk drawer.
* [Leave with your loot] -> ending_rich
* [Head for the cellar instead] -> cellar

=== cellar ===
~ temp coins_per_torch = gold / torches
You count {coins_per_torch} coins per torch as the stairs groan.
-> ending_trapped

=== ending_rich ===
You slip out the servant door, heavier by half a purse. -> END

=== ending_trapped ===
The cellar door slams above you. -> END

=== treasure_vault ===
Gold beyond counting — but no divert leads here. -> END
