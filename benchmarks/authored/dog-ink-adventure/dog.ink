CONST MaxDogHunger = 40
CONST MaxDogThirst = 20

VAR DogHungry = MaxDogHunger
VAR DogThirsty = MaxDogThirst

~ DeclareCharacter(Dog,Bedroom)

=== tunnel_dog_tick

~ DogHungry += 1
~ DogThirsty += 1

{ 
    //The dog is thirsty
    - DogThirsty > MaxDogThirst:
        -> tunnel_dog_thirsty ->
        
    //The dog is hungry
    - DogHungry > MaxDogHunger:
        -> tunnel_dog_hungry ->
        
    //The dog wants to play with the stick
    //The player is already holding it, so chase the player
    -   HasItem(Stick):
        { NPCMove(Dog,Player) == false:
            The dog is trying to wrestle the stick from you.
        }

    //The dog has the stick already, so bring to the palyer
    -  Owner(Stick) == Dog:
        { NPCMove(Dog,Player) == false:
            The dog has dropped the stick in front of you.
            ~ DropItem(Stick)
        }
        
    - NPCMove(Dog,Stick):
        //The dog is moving towards stick

    - AreInSameRoom(Dog,Player):
        The dog is shyly looking at you and the stick.

    - else:
        //The dog must have reached the stick, pick it up "off screen"
        ~ PickUpItem(Dog,Stick)
}
->->


=== tunnel_dog_thirsty
{ NPCMove(Dog,WaterBowl) == true:
    //Moving towards water bowl
    ->->
}

{ IsFull has WaterBowl && AreInSameRoom(WaterBowl,Dog):
    Dog is drinking from the water bowl.
    ~ DogThirsty = 0
    ~ IsFull -= WaterBowl
    ->->
}
Dog is barking at the water bowl.
->->

=== tunnel_dog_hungry
{ NPCMove(Dog,FoodBowl) == true:
    //Moving towards food bowl
    ->->
}

{ IsFull has FoodBowl && AreInSameRoom(FoodBowl,Dog):
    Dog has eaten all of the food.
    ~ DogHungry = 0
    ~ IsFull -= FoodBowl
    ->->
}
Dog is barking at the food bowl.
->->


