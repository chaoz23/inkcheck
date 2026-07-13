=== tick
You are in the {GetRoom(Player)}.

-> tunnel_dog_tick ->

{ RunningTaps has GetRoom(Player):
    The tap is currently running.
}

~ DescribeAllItems()

+ { HasItem(FoodBowl) && HasFood(GetRoom(Player)) && IsFull hasnt FoodBowl } [ Put food in dog's food bowl ]
    You've filled the dog's bowl with food
    ~ IsFull += FoodBowl
    -> tick
    
+ { HasItem(WaterBowl) && RunningTaps has GetRoom(Player) && IsFull hasnt WaterBowl } [ Put water in dog's water bowl ]
    You've filled the dog's bowl with water
    ~ IsFull += WaterBowl
    -> tick    

+ { LIST_COUNT(AllItems_InRoom(GetRoom(Player))) > 0 } [ Pick up item ] -> PickupItemMenu

+ { LIST_COUNT(AllItems_InRoom(Player)) > 0 } [ Drop item ] -> DropItemMenu

+ { HasTap(GetRoom(Player)) && RunningTaps hasnt GetRoom(Player) } [ Turn on tap ]
    ~ RunningTaps += GetRoom(Player)
    -> tick

+ { RunningTaps has GetRoom(Player) == true } [ Turn off tap ]
    ~ RunningTaps -= GetRoom(Player)
    -> tick

+ [ Go to ]
    -> GotoMenu

+ [ Wait ]
    -> tick

=== GotoMenu
<- GenerateRoomOptions(AdjacentTo(GetRoom(Player)))
+ [ Never mind ] -> tick

=== PickupItemMenu
<- GeneratePickupOptions(AllItems_InRoom(GetRoom(Player)))
+ [ Never mind ] -> tick

=== DropItemMenu
<- GenerateDropOptions(AllItems_InRoom(Player))
+ [ Never mind ] -> tick

