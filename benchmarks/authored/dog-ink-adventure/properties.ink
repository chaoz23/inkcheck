//List of entities that are full of water, food etc
VAR IsFull = ()

//List of entities that CAN be filled
VAR CanBeFilled = (FoodBowl,WaterBowl)

//List of rooms that have a RUNNING tap
VAR RunningTaps = ()

//Check that this room has food
=== function HasFood(room)
~ return (Pantry) has room

//Check that this room has a tap
=== function HasTap(room)
~ return (Kitchen,Lawn,Bathroom) has room
