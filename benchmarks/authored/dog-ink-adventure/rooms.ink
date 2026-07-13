//Used for binary lookups so we can apply a room to any item
VAR LocationB1 = ()
VAR LocationB2 = ()
VAR LocationB4 = ()
VAR LocationB8 = ()
VAR LocationB16 = ()
VAR LocationB32 = ()
VAR LocationB64 = ()
VAR LocationB128 = ()

~ DeclareRoom(Bedroom)
~ DeclareRoom(Bathroom)
~ DeclareRoom(Hallway)
~ DeclareRoom(Staircase)
~ DeclareRoom(LivingRoom)
~ DeclareRoom(Kitchen)
~ DeclareRoom(Lawn)
~ DeclareRoom(Pantry)

=== function AdjacentTo(room)
{ room:
    - Bedroom: ~ return (Hallway)
    - Bathroom: ~ return (Hallway)
    - Hallway: ~ return (Bedroom, Bathroom, Staircase)
    - Staircase: ~ return (Hallway, LivingRoom)
    - LivingRoom: ~ return (Kitchen, Lawn, Staircase)
    - Lawn: ~ return (LivingRoom)
    - Kitchen: ~ return (LivingRoom,Pantry)
    - Pantry: ~ return (Kitchen)
}

=== function AreInSameRoom(entity1,entity2)
~ return GetRoom(entity1) == GetRoom(entity2)

//Returns true if the character moved, false if the character didn't because already in the same room
=== function NPCMove(character,room)
~ temp nextRoom = PathFind(character,room)
{ GetRoom(character) != nextRoom:
    
    { GetRoom(Player) == nextRoom:
        {character} has entered the {nextRoom} from the {GetRoom(character)}
    }
    
    { GetRoom(Player) == GetRoom(character):
        {character} has left in the direction of the {nextRoom}
    }    
    
    ~ SetRoom(character,nextRoom)
    
    //We successfully moved
    ~ return true
}

//Already in the same room
~ return false 

=== function GetRoom(entity)
//We need to cast it back to the entity
~ return Entities(GetItemValue(entity,LocationB1,LocationB2,LocationB4,LocationB8,LocationB16,LocationB32,LocationB64,LocationB128))

=== function SetRoom(entity,room)
~ SetItemValue(entity,LIST_VALUE(room),LocationB1,LocationB2,LocationB4,LocationB8,LocationB16,LocationB32,LocationB64,LocationB128)
~ return

//Finds the next step between any two rooms in the game
=== function PathFind(from,to)
//We're pathfinding from a character
{ Characters has from:
    ~ from = GetRoom(from)  
}

//We're pathfinding to an item
{ Items has to:
    ~ to = GetRoom(to)
}

//We're pathfinding to a character (such as a character holding the item we're chasing)
{ Characters has to:
    ~ to = GetRoom(to)
}

//Are we already in the right room?
{ to == from:
    ~ return to
}
~ temp roomsToCheckNow = ()
~ roomsToCheckNow += to
~ return PathFindRecursively(roomsToCheckNow,(),(),from)

=== GenerateRoomOptions(rooms)
//No more rooms need to be added to the list
{ LIST_COUNT(rooms) == 0:
    -> DONE
}
~ temp thisRoom = LIST_MIN(rooms)
<- GenerateRoomOptions(rooms - thisRoom)

+ [ Go to {thisRoom} ] 
    ~ SetRoom(Player,thisRoom)
    -> tick

- -> DONE

//Inner recursive function for pathfinding
=== function PathFindRecursively(roomsToCheckNow, roomsToCheckNext, roomsToExclude, startingPoint)
{ LIST_COUNT(roomsToCheckNow) == 0:
    //We're out of rooms in the current list to check, go to the next list
    ~ roomsToCheckNow = roomsToCheckNext - roomsToExclude
    ~ roomsToCheckNext = ()
}

~ temp roomToCheck = LIST_MIN(roomsToCheckNow)
~ roomsToCheckNow -= roomToCheck

//Is this room adjacent to the starting point? If so, we have our path
{ AdjacentTo(roomToCheck) has startingPoint:
    ~ return roomToCheck
}

//We don't need to check this room again
~ roomsToExclude += roomToCheck

//Otherwise, populate rooms to check next with all adjacent rooms, and dig deeper
~ roomsToCheckNext += AdjacentTo(roomToCheck)
~ return PathFindRecursively(roomsToCheckNow,roomsToCheckNext,roomsToExclude,startingPoint)







