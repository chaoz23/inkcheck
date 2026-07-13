//This is simply an interface for storing a value against a list item, for a value of 0-255
//Eight lists need to be provided for each kind of value, for each bit value of that value
//Range can be expanded by simply adding more binary lists

=== function GetItemValue(item,ref Binary1,ref Binary2,ref Binary4,ref Binary8,ref Binary16,ref Binary32,ref Binary64, ref Binary128)

~ temp result = 0
~ GetItemValueInner(128,Binary128,item,result)
~ GetItemValueInner(64,Binary64,item,result)
~ GetItemValueInner(32,Binary32,item,result)
~ GetItemValueInner(16,Binary16,item,result)
~ GetItemValueInner(8,Binary8,item,result)
~ GetItemValueInner(4,Binary4,item,result)
~ GetItemValueInner(2,Binary2,item,result)
~ GetItemValueInner(1,Binary1,item,result)
~ return result

=== function GetItemValueInner(amount,ref list,item,ref result)
{ list has item:
    ~ result += amount
}
~ return

=== function SetItemValue(item,value,ref Binary1,ref Binary2,ref Binary4,ref Binary8,ref Binary16,ref Binary32,ref Binary64, ref Binary128)
~ SetItemValueInner(128,Binary128,item,value)
~ SetItemValueInner(64,Binary64,item,value)
~ SetItemValueInner(32,Binary32,item,value)
~ SetItemValueInner(16,Binary16,item,value)
~ SetItemValueInner(8,Binary8,item,value)
~ SetItemValueInner(4,Binary4,item,value)
~ SetItemValueInner(2,Binary2,item,value)
~ SetItemValueInner(1,Binary1,item,value)
~ return

=== function SetItemValueInner(amount, ref list, item, ref value)
{ 
    - value >= amount:
        ~ value -= amount
        ~ list += item
    - else:
        ~ list -= item
}
~ return