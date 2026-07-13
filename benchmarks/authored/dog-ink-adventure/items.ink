~ DeclareItem(FoodBowl,Kitchen)
~ DeclareItem(WaterBowl,Lawn)
~ DeclareItem(Stick,Bedroom)

=== function DescribeAllItems()
~ temp itemList = ()
~ itemList += AllItems_InRoom(GetRoom(Player))
~ DescribeAllItems_Inner(itemList)
~ return

=== function DescribeAllItems_Inner(itemList)
{ LIST_COUNT(itemList) > 0:
    ~ temp item = LIST_MIN(itemList)
    ~ DescribeItem(item)
    ~ DescribeAllItems_Inner(itemList - item)
}
~ return

=== function DescribeItem(item)
{ 
    - CanBeFilled has item:
        The {item} is here, and it is {IsFull has item:full|empty}.
    - else:
        The {item} is here.
}
~ return

=== function Owner(item)
{ Characters has GetRoom(item):
    ~ return GetRoom(item)
}
~ return NA

=== function PickUpItem(character,item)
~ SetRoom(item,character)
~ return

//We don't need to know the character when dropping an item, as we'll work that out
=== function DropItem(item)
~ SetRoom(item,GetRoom(Owner(item)))
~ return

=== function HasItem(item)
~ return Owner(item) == Player

=== function AllItems_InRoom(room)
~ temp itemList = ()
~ itemList += Items
~ return AllItems_InRoom_Recursive(room,itemList,())

=== function AllItems_InRoom_Recursive(room,list,outList)
{ LIST_COUNT(list) == 0:
    //We're finished
    ~ return outList
}

//Check that the next item on the list is in this room
~ temp nextItem = LIST_MIN(list)
~ list -= nextItem
{ GetRoom(nextItem) == room:
    ~ outList += nextItem
}
~ return AllItems_InRoom_Recursive(room,list,outList)

=== function Item_IsInRoom(room,item)
~ return AllItems_InRoom(room) has item

=== GeneratePickupOptions(items)
//No more items need to be added to the list
{ LIST_COUNT(items) == 0:
    -> DONE
}
~ temp thisItem = LIST_MIN(items)
<- GeneratePickupOptions(items - thisItem)

+ [ Pick up {thisItem} ] 
    ~ PickUpItem(Player,thisItem)
    -> tick

- -> DONE

=== GenerateDropOptions(items)
//No more items need to be added to the list
{ LIST_COUNT(items) == 0:
    -> DONE
}
~ temp thisItem = LIST_MIN(items)
<- GenerateDropOptions(items - thisItem)

+ [ Drop {thisItem} ] 
    ~ DropItem(thisItem)
    -> tick

- -> DONE
