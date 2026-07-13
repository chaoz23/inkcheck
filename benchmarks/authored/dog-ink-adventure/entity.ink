//Includes ALL entities (rooms, items and characters) in the game
//No more than 255 (could be expanded by making the binary class larger
//Null/NA is zero
LIST Entities = (NA=0), Bedroom, Bathroom, Hallway, Staircase, LivingRoom, Kitchen, Lawn, Pantry, Stick, FoodBowl, WaterBowl, Dog, Player

VAR Items = ()
VAR Characters = ()
VAR Rooms = ()

//Adds entity to global list
=== function DeclareRoom(room)
~ Rooms += room
~ return

//Adds item to global list and sets the room for it
=== function DeclareItem(item,room)
~ Items += item
~ SetRoom(item,room)
~ return

//Declares a character with an inventory and sets the room for it
=== function DeclareCharacter(character,room)
~ Characters += character
~ SetRoom(character,room)
~ return
